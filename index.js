"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const crypto = require("crypto");

// ============================================================
// CONFIG (settings.json merged over safe defaults so a missing key never crashes the bot)
// ============================================================
const DEFAULT_CONFIG = {
  name: "AFK Bot",
  "bot-account": { username: "AFKBot", password: "", type: "offline" },
  server: { ip: "localhost", port: 25565, version: "", "try-creative": false },
  position: { enabled: false, x: 0, y: 100, z: 0 },
  utils: {
    "auto-auth": { enabled: false, password: "" },
    "anti-afk": { enabled: true, sneak: false },
    "chat-messages": { enabled: false, repeat: false, "repeat-delay": 600, messages: [] },
    "auto-reconnect": true,
    "auto-reconnect-delay": 3000,
    "max-reconnect-delay": 100000,
  },
  movement: {
    enabled: true,
    "circle-walk": { enabled: false, radius: 4, speed: 3000 },
    "look-around": { enabled: false, interval: 5000 },
    "random-jump": { enabled: false, interval: 10000 },
  },
  modules: { avoidMobs: false, combat: false, beds: false, chat: false },
  combat: { "attack-mobs": false, "auto-eat": false },
  beds: { "pick-up-day": false, "place-night": false },
  discord: { enabled: false, webhookUrl: "", events: { connect: true, disconnect: true, chat: false } },
  chat: { respond: false, admins: [] },
  // physics OFF = bot stands still and never sends movement packets (stable on brand-new versions)
  physics: { enabled: false },
  // Scheduled leave/rejoin cycle: stay online "stay-minutes", leave, wait "away-seconds", rejoin.
  "leave-rejoin": { enabled: false, "stay-minutes": 30, "away-seconds": 10 },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const key of Object.keys(extra || {})) {
    out[key] =
      key in base && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
        ? deepMerge(base[key], extra[key])
        : extra[key];
  }
  return out;
}

const config = deepMerge(DEFAULT_CONFIG, require("./settings.json"));
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
app.use(express.json({ limit: "10kb" }));

// Optional password protection. Set DASHBOARD_PASSWORD in your host's environment variables.
// (The dashboard can send chat/commands as the bot, so do not leave it public.)
// /ping stays open so uptime monitors keep working.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest();
app.use((req, res, next) => {
  if (!DASHBOARD_PASSWORD || req.path === "/ping") return next();
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
    if (crypto.timingSafeEqual(sha256(pass), sha256(DASHBOARD_PASSWORD))) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Bot Dashboard"').status(401).send("Authentication required");
});

const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  connectedAt: 0,
  plannedLeave: false,
  nextLeaveAt: 0,
  useNewestSupported: false,
  safeMode: !(config.physics && config.physics.enabled),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
          }

          main { width: 100%; max-width: 400px; }

          header { margin-bottom: 28px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .status-section {
            border-radius: 12px;
            padding: 20px 24px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 16px;
            transition: background 0.3s, border-color 0.3s;
          }
          .status-section.online  { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #200d0d; border: 2px solid #da3633; }

          .status-icon {
            width: 44px; height: 44px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 20px; flex-shrink: 0;
            transition: background 0.3s;
          }
          .status-icon.online  { background: #238636; }
          .status-icon.offline { background: #da3633; }

          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; transition: color 0.3s; }
          .status-label.online  { color: #3fb950; }
          .status-label.offline { color: #f85149; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }

          dl { margin: 0; }
          .stat-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 10px;
            padding: 16px 20px;
            margin-bottom: 10px;
          }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }

          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }

          .btn-primary {
            min-height: 52px; border-radius: 10px;
            font-size: 15px; font-weight: 700;
            cursor: pointer; letter-spacing: 0.3px;
            transition: opacity 0.2s, filter 0.2s;
            font-family: inherit;
          }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-primary:active { opacity: 0.85; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }

          .btn-secondary {
            min-height: 44px; border-radius: 10px;
            border: 1px solid #21262d; background: #161b22; color: #8b949e;
            font-size: 13px; font-weight: 500;
            text-decoration: none;
            display: flex; align-items: center; justify-content: center;
            font-family: inherit; cursor: pointer;
            transition: background 0.2s, color 0.2s;
          }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }

          footer { margin-top: 20px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main role="main" aria-label="AFK Bot Dashboard">

          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Live status</p>
          </header>

          <section
            id="status-section"
            role="status"
            aria-live="polite"
            aria-label="Bot connection status"
            class="status-section offline"
          >
            <div id="status-icon" aria-hidden="true" class="status-icon offline">&#x2717;</div>
            <div>
              <div id="status-label" class="status-label offline">Connecting…</div>
              <div id="status-detail" class="status-detail">Establishing connection</div>
            </div>
          </section>

          <section aria-label="Bot statistics">
            <dl>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">—</dd>
                <p class="stat-detail">Time since last connection</p>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching…</dd>
                <p class="stat-detail">Bot's current in-game position</p>
              </div>
              <div class="stat-card">
                <dt>Server address</dt>
                <dd>${config.server.ip}</dd>
                <p class="stat-detail">Minecraft server hostname</p>
              </div>
            </dl>
          </section>

          <section class="controls" aria-label="Bot controls">
            <div class="btn-grid btn-grid-2">
              <button class="btn-primary btn-start" onclick="startBot()" aria-label="Start bot">Start bot</button>
              <button class="btn-primary btn-stop" onclick="stopBot()" aria-label="Stop bot">Stop bot</button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary" aria-label="View setup guide">Setup guide</a>
              <a href="/logs" class="btn-secondary" aria-label="View bot logs">View logs</a>
            </div>
          </section>

          <footer>
            <p>Status updates every 5 seconds</p>
          </footer>

        </main>

        <script>
          function formatUptime(s) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              const online = data.status === 'connected';

              const section = document.getElementById('status-section');
              const icon    = document.getElementById('status-icon');
              const label   = document.getElementById('status-label');
              const detail  = document.getElementById('status-detail');

              section.className = 'status-section ' + (online ? 'online' : 'offline');
              icon.className    = 'status-icon '    + (online ? 'online' : 'offline');
              icon.textContent  = online ? '✓' : '✗';
              label.className   = 'status-label '   + (online ? 'online' : 'offline');
              label.textContent = online ? 'Connected' : 'Disconnected';
              detail.textContent = online ? 'Bot is active on the server' : 'Attempting to reconnect';

              document.getElementById('uptime-text').textContent = formatUptime(data.uptime);

              if (data.coords) {
                const x = Math.floor(data.coords.x);
                const y = Math.floor(data.coords.y);
                const z = Math.floor(data.coords.z);
                document.getElementById('coords-text').textContent = 'X ' + x + ', Y ' + y + ', Z ' + z;
              } else {
                document.getElementById('coords-text').textContent = 'Searching…';
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot started!' : data.msg);
            update();
          }

          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot stopped!' : data.msg);
            update();
          }

          setInterval(update, 5000);
          update();
        </script>
      </body>
    </html>
  `);
});
app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Setup Guide</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 560px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          header { margin-bottom: 32px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .step-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 16px;
          }

          .step-header {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 18px;
          }

          .step-number {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: #0d2218;
            border: 2px solid #238636;
            color: #3fb950;
            font-size: 14px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .step-title {
            font-size: 16px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
          }

          ol {
            margin: 0;
            padding: 0;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          li {
            font-size: 14px;
            color: #8b949e;
            line-height: 1.6;
            padding-left: 20px;
            position: relative;
          }

          li::before {
            content: "·";
            position: absolute;
            left: 6px;
            color: #3fb950;
            font-weight: 700;
          }

          li strong { color: #e6edf3; font-weight: 600; }

          code {
            background: #21262d;
            border: 1px solid #30363d;
            padding: 2px 7px;
            border-radius: 5px;
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 12px;
            color: #e6edf3;
          }

          a { color: #58a6ff; text-decoration: none; }
          a:hover { text-decoration: underline; }

          footer {
            margin-top: 32px;
            text-align: center;
          }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <header>
            <h1>Setup Guide</h1>
            <p>Get your AFK bot running in under 15 minutes</p>
          </header>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">1</div>
              <h2 class="step-title">Configure Aternos</h2>
            </div>
            <ol>
              <li>Go to <strong>Aternos</strong> and open your server.</li>
              <li>Install <strong>Paper/Bukkit</strong> as your server software.</li>
              <li>Enable <strong>Cracked</strong> mode using the green switch.</li>
              <li>Install these plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code></li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">2</div>
              <h2 class="step-title">GitHub Setup</h2>
            </div>
            <ol>
              <li>Download this project as a ZIP and extract it.</li>
              <li>Edit <code>settings.json</code> with your server IP and port.</li>
              <li>Upload all files to a new <strong>GitHub Repository</strong>.</li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">3</div>
              <h2 class="step-title">Deploy on Replit (Free 24/7)</h2>
            </div>
            <ol>
              <li>Import your GitHub repo into <strong>Replit</strong>.</li>
              <li>Set the run command to <code>npm start</code>.</li>
              <li>Hit <strong>Run</strong> — the bot connects automatically.</li>
              <li>The bot pings itself every 10 minutes to stay alive.</li>
            </ol>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: botState.connected && botState.connectedAt ? Math.floor((Date.now() - botState.connectedAt) / 1000) : 0,
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    nextLeaveIn: botState.nextLeaveAt ? Math.max(0, Math.round((botState.nextLeaveAt - Date.now()) / 1000)) : null,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  const logs = getLogs();

  const escapeHTML = (str) =>
    str.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );

  const logCount = logs.length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Logs</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 760px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          .page-header {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            margin-bottom: 20px;
            gap: 12px;
            flex-wrap: wrap;
          }

          .page-header-left h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          .page-header-left p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
          }

          .badge {
            font-size: 12px;
            font-weight: 600;
            color: #8b949e;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 20px;
            padding: 4px 12px;
            white-space: nowrap;
          }

          .log-card {
            background: #0d1117;
            border: 1px solid #21262d;
            border-radius: 12px;
            overflow: hidden;
          }

          .log-card-header {
            background: #161b22;
            border-bottom: 1px solid #21262d;
            padding: 12px 18px;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .dot-red   { background: #ff5f57; }
          .dot-yellow{ background: #ffbd2e; }
          .dot-green { background: #28c840; }

          .log-card-title {
            font-size: 12px;
            font-weight: 500;
            color: #484f58;
            margin-left: 4px;
          }

          .log-body {
            padding: 16px 18px;
            max-height: 560px;
            overflow-y: auto;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            line-height: 1.7;
          }

          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error   { color: #ff7b72; }
          .log-entry.warn    { color: #e3b341; }
          .log-entry.success { color: #3fb950; }
          .log-entry.control { color: #58a6ff; }
          .log-entry.default { color: #8b949e; }

          .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: #484f58;
            font-size: 13px;
          }

          .refresh-bar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            margin-top: 12px;
            font-size: 12px;
            color: #484f58;
          }
          .refresh-dot {
            width: 7px; height: 7px;
            border-radius: 50%;
            background: #3fb950;
            animation: pulse 2s infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }

          .console-row {
            display: flex;
            align-items: center;
            border-top: 1px solid #21262d;
            background: #0d1117;
            padding: 10px 18px;
            gap: 10px;
          }

          .console-prompt {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 13px;
            color: #3fb950;
            font-weight: 700;
            flex-shrink: 0;
            user-select: none;
          }

          .console-input {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            color: #e6edf3;
            caret-color: #3fb950;
          }

          .console-input::placeholder { color: #484f58; }

          .console-send {
            background: #0d2218;
            border: 1px solid #238636;
            color: #3fb950;
            font-size: 12px;
            font-weight: 600;
            padding: 5px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.2s;
            flex-shrink: 0;
          }
          .console-send:hover { background: #122d1a; }
          .console-send:disabled { opacity: 0.5; cursor: default; }

          .console-wrap {
            position: relative;
          }

          .cmd-suggestions {
            display: none;
            position: absolute;
            bottom: calc(100% + 6px);
            left: 0; right: 0;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 10;
          }

          .cmd-suggestions.visible { display: block; }

          .cmd-item {
            display: flex;
            align-items: baseline;
            gap: 12px;
            padding: 9px 16px;
            cursor: pointer;
            transition: background 0.12s;
            border-bottom: 1px solid #21262d;
          }
          .cmd-item:last-child { border-bottom: none; }
          .cmd-item:hover, .cmd-item.active {
            background: #21262d;
          }

          .cmd-name {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            font-weight: 700;
            color: #3fb950;
            flex-shrink: 0;
            min-width: 90px;
          }

          .cmd-desc {
            font-size: 12px;
            color: #6e7681;
          }

          footer { margin-top: 32px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <div class="page-header">
            <div class="page-header-left">
              <h1>Bot Logs</h1>
              <p>Live output from the AFK bot</p>
            </div>
            <span class="badge">${logCount} ${logCount === 1 ? "entry" : "entries"}</span>
          </div>

          <div class="log-card">
            <div class="log-card-header">
              <span class="dot dot-red"></span>
              <span class="dot dot-yellow"></span>
              <span class="dot dot-green"></span>
              <span class="log-card-title">bot.log</span>
            </div>
            <div class="log-body" id="log-body">
              ${logCount === 0
                ? `<div class="empty-state">No log entries yet. Start the bot to see output.</div>`
                : logs.map((l) => {
                    const escaped = escapeHTML(l);
                    const lower = l.toLowerCase();
                    let cls = "default";
                    if (lower.includes("error") || lower.includes("fail")) cls = "error";
                    else if (lower.includes("warn")) cls = "warn";
                    else if (lower.includes("[control]")) cls = "control";
                    else if (lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) cls = "success";
                    return `<span class="log-entry ${cls}">${escaped}</span>`;
                  }).join("")
              }
            </div>
            <div class="console-wrap">
              <div class="cmd-suggestions" id="cmd-suggestions"></div>
              <div class="console-row">
                <span class="console-prompt">&gt;</span>
                <input
                  id="console-input"
                  class="console-input"
                  type="text"
                  placeholder="Type / for commands, or any message…"
                  autocomplete="off"
                  spellcheck="false"
                >
                <button id="console-send" class="console-send">Send</button>
              </div>
            </div>
          </div>

          <div class="refresh-bar">
            <span class="refresh-dot"></span>
            <span id="refresh-label">Auto-refreshing every 5 seconds</span>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>

        <script>
          (function() {
            var logBody  = document.getElementById('log-body');
            var input    = document.getElementById('console-input');
            var sendBtn  = document.getElementById('console-send');
            var label    = document.getElementById('refresh-label');
            var sugBox   = document.getElementById('cmd-suggestions');
            var refreshTimer = null;
            var typing = false;
            var activeIdx = -1;

            var COMMANDS = [
              { name: '/help',   desc: 'Show all available commands' },
              { name: '/pos',    desc: "Show bot's current coordinates" },
              { name: '/status', desc: 'Show connection status & uptime' },
              { name: '/list',   desc: 'List players on the server' },
              { name: '/say',    desc: 'Send a chat message in-game' },
            ];

            function scrollBottom() {
              if (logBody) logBody.scrollTop = logBody.scrollHeight;
            }

            function scheduleRefresh() {
              clearTimeout(refreshTimer);
              if (!typing) {
                refreshTimer = setTimeout(function() { location.reload(); }, 5000);
              }
            }

            function appendLocalEntry(text, cls) {
              var span = document.createElement('span');
              span.className = 'log-entry ' + (cls || 'control');
              span.textContent = text;
              logBody.appendChild(span);
              scrollBottom();
            }

            function hideSuggestions() {
              sugBox.classList.remove('visible');
              sugBox.innerHTML = '';
              activeIdx = -1;
            }

            function setActive(idx) {
              var items = sugBox.querySelectorAll('.cmd-item');
              items.forEach(function(el, i) {
                el.classList.toggle('active', i === idx);
              });
              activeIdx = idx;
            }

            function showSuggestions(val) {
              var query = val.toLowerCase();
              var matches = COMMANDS.filter(function(c) {
                return c.name.startsWith(query);
              });

              if (!matches.length) { hideSuggestions(); return; }

              sugBox.innerHTML = matches.map(function(c, i) {
                return '<div class="cmd-item" data-cmd="' + c.name + '">' +
                  '<span class="cmd-name">' + c.name + '</span>' +
                  '<span class="cmd-desc">' + c.desc + '</span>' +
                '</div>';
              }).join('');

              sugBox.querySelectorAll('.cmd-item').forEach(function(el) {
                el.addEventListener('mousedown', function(e) {
                  e.preventDefault();
                  input.value = el.dataset.cmd + ' ';
                  hideSuggestions();
                  input.focus();
                });
              });

              activeIdx = -1;
              sugBox.classList.add('visible');
            }

            input.addEventListener('input', function() {
              var val = input.value;
              if (val.startsWith('/')) {
                showSuggestions(val);
              } else {
                hideSuggestions();
              }
            });

            input.addEventListener('keydown', function(e) {
              var items = sugBox.querySelectorAll('.cmd-item');
              if (sugBox.classList.contains('visible') && items.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive(Math.min(activeIdx + 1, items.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive(Math.max(activeIdx - 1, 0));
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && activeIdx >= 0)) {
                  e.preventDefault();
                  var chosen = items[activeIdx >= 0 ? activeIdx : 0];
                  input.value = chosen.dataset.cmd + ' ';
                  hideSuggestions();
                  return;
                }
                if (e.key === 'Escape') {
                  hideSuggestions();
                  return;
                }
              }
              if (e.key === 'Enter') sendCommand();
            });

            function sendCommand() {
              var cmd = input.value.trim();
              if (!cmd) return;
              hideSuggestions();
              input.value = '';
              sendBtn.disabled = true;
              appendLocalEntry('> ' + cmd, 'control');

              fetch('/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
              })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (data.msg) {
                  data.msg.split('\\n').forEach(function(line) {
                    appendLocalEntry(line, data.success ? 'default' : 'error');
                  });
                }
              })
              .catch(function() {
                appendLocalEntry('Failed to send command.', 'error');
              })
              .finally(function() {
                sendBtn.disabled = false;
                input.focus();
                scheduleRefresh();
              });
            }

            sendBtn.addEventListener('click', sendCommand);

            input.addEventListener('focus', function() {
              typing = true;
              clearTimeout(refreshTimer);
              label.textContent = 'Auto-refresh paused while typing';
            });
            input.addEventListener('blur', function() {
              setTimeout(function() {
                hideSuggestions();
                typing = false;
                label.textContent = 'Auto-refreshing every 5 seconds';
                scheduleRefresh();
              }, 150);
            });

            scrollBottom();
            scheduleRefresh();
          })();
        </script>
      </body>
    </html>
  `);
});

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });

  botRunning = true;
  isReconnecting = false;
  botState.reconnectAttempts = 0;
  createBot();
  addLog("[Control] Bot started");

  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });

  botRunning = false;
  isReconnecting = false;
  clearBotTimeouts();
  clearAllIntervals();
  disposeBot(bot);
  bot = null;
  botState.connected = false;
  botState.connectedAt = 0;
  addLog("[Control] Bot stopped");

  res.json({ success: true });
});

app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          - Show this help message",
      "  /pos           - Show bot's current coordinates",
      "  /status        - Show bot connection status",
      "  /list          - Ask server for player list",
      "  /say <message> - Send a chat message in-game",
      "  /<anything>    - Send any Minecraft command directly",
      "  <text>         - Send plain chat (no slash needed)",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot && bot.entity ? bot.entity.position : null;
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const status = botState.connected ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}${botState.nextLeaveAt ? ` | Next rest in: ${Math.max(0, Math.round((botState.nextLeaveAt - Date.now()) / 60000))}min` : ""}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot
      ? "Bot is still connecting — try again in a moment."
      : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent to server: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// ============================================================
//                    END OF WEB TOOLS
//============================================================

// FIX: handle port conflict gracefully - try next port if taken
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port} `);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying port ${fallbackPort} `);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message} `);
  }
});

// FIX: only one definition of formatUptime
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// FIX: only ping if RENDER_EXTERNAL_URL is set (skip useless localhost ping)
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    addLog(
      "[KeepAlive] No RENDER_EXTERNAL_URL set - self-ping disabled (running locally)",
    );
    return;
  }
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol
      .get(`${renderUrl}/ping`, (res) => {
        // Silent success
      })
      .on("error", (err) => {
        addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
      });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping system started (every 10 min)");
}

startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(
  () => {
    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    addLog(`[Memory] Heap: ${heapMB} MB`);
  },
  5 * 60 * 1000,
);

// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
// ============================================================
// RECONNECTION & TIMEOUT MANAGEMENT
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;

let leaveTimeoutId = null;

function clearLeaveTimer() {
  if (leaveTimeoutId) {
    clearTimeout(leaveTimeoutId);
    leaveTimeoutId = null;
  }
  botState.nextLeaveAt = 0;
}

function clearBotTimeouts() {
  clearLeaveTimer();
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

// FIX: Discord rate limiting - track last send time
let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000; // min 5s between webhook calls

function clearAllIntervals() {
  addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
    addLog(
      `[Bot] Throttle detected - using extended delay: ${throttleDelay / 1000}s`,
    );
    return throttleDelay;
  }

  // FIX: read auto-reconnect-delay from settings as base delay
  const baseDelay = config.utils["auto-reconnect-delay"] || 3000;
  const maxDelay = config.utils["max-reconnect-delay"] || 30000;
  const delay = Math.min(
    baseDelay * Math.pow(2, botState.reconnectAttempts),
    maxDelay,
  );
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isFiniteNumber = (n) => typeof n === "number" && Number.isFinite(n);

function pushError(entry) {
  botState.errors.push({ ...entry, time: Date.now() });
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);
}

// Safely tear a bot down without leaving an 'error' event unhandled (which would crash Node).
function disposeBot(b) {
  if (!b) return;
  try {
    b.removeAllListeners();
    b.on("error", () => {});
    b.end();
  } catch (e) {
    addLog(`[Cleanup] Error ending bot: ${e.message}`);
  }
}

// Clamp + validate look angles. NaN/Infinity here is exactly what makes a vanilla
// server answer with "Invalid move player packet received".
function safeLook(b, yaw, pitch, force = false) {
  if (!b || typeof b.look !== "function") return;
  if (!isFiniteNumber(yaw) || !isFiniteNumber(pitch)) return;
  const maxPitch = Math.PI / 2 - 0.01;
  const p = Math.max(-maxPitch, Math.min(maxPitch, pitch));
  b.look(yaw, p, force).catch(() => {});
}

// Last line of defence against "Invalid move player packet received":
//  1. any outgoing movement packet containing NaN/Infinity is dropped (and logged) instead of sent
//  2. pitch is clamped to [-90, 90]
//  3. if the bot's physics state ever turns into NaN it is reset to the last good position
function installPacketGuard(b) {
  const client = b._client;
  if (!client || client.__packetGuard) return;
  client.__packetGuard = true;

  const MOVE_PACKETS = new Set(["position", "position_look", "look", "flying", "vehicle_move"]);
  const rawWrite = client.write.bind(client);
  let dropped = 0;

  client.write = (name, params) => {
    // Static mode: the bot never sends ANY movement/look packet, so the server has nothing
    // it could reject as "Invalid move player packet" (teleport confirmations still go through).
    if (botState.safeMode && MOVE_PACKETS.has(name)) return;
    if (MOVE_PACKETS.has(name) && params) {
      const bad = ["x", "y", "z", "yaw", "pitch"].filter((k) => k in params && !Number.isFinite(params[k]));
      if (bad.length) {
        dropped++;
        if (dropped <= 5 || dropped % 100 === 0) {
          addLog(`[Guard] Dropped invalid '${name}' packet (bad fields: ${bad.join(", ")}) - total dropped: ${dropped}`);
        }
        return;
      }
      if ("pitch" in params) params.pitch = Math.max(-90, Math.min(90, params.pitch));
    }
    return rawWrite(name, params);
  };

  let lastGood = null;
  b.on("physicsTick", () => {
    const e = b.entity;
    if (!e || !e.position) return;
    const p = e.position;
    if (isFiniteNumber(p.x) && isFiniteNumber(p.y) && isFiniteNumber(p.z)) {
      lastGood = { x: p.x, y: p.y, z: p.z };
    } else if (lastGood) {
      addLog("[Guard] Bot position became NaN - restoring last good position");
      p.set(lastGood.x, lastGood.y, lastGood.z);
    }
    const v = e.velocity;
    if (v && !(isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z))) v.set(0, 0, 0);
  });
}

// Wait until the world around the bot is loaded before any movement/look logic runs.
async function waitUntilWorldReady(b) {
  try {
    if (typeof b.waitForChunksToLoad === "function") {
      await Promise.race([b.waitForChunksToLoad(), sleep(20000)]);
    }
  } catch (_) {
    /* ignore - fall through to the fixed delay */
  }
  await sleep(2000);
}

// Pick the Minecraft protocol version for mineflayer:
//  - empty "version" in settings.json -> auto-detect from the server (best for new releases)
//  - version supported by the installed mineflayer -> use it
//  - version NEWER than mineflayer knows -> use mineflayer's newest (works if the server has
//    ViaVersion, as in the setup guide) and tell the user to update mineflayer
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function resolveBotVersion() {
  // The version in settings.json is ignored on purpose: the bot always joins with the
  // server's own (latest) version, auto-detected from the server. Only if mineflayer
  // reported that it cannot speak that version do we fall back to mineflayer's newest
  // supported version (works through ViaVersion).
  if (!botState.useNewestSupported) return false;
  const supported = Array.isArray(mineflayer.supportedVersions) ? mineflayer.supportedVersions : [];
  if (!supported.length) return false;
  const newest = supported.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  addLog(`[Version] Auto-detect failed - joining with newest version supported by mineflayer: ${newest}`);
  return newest;
}

function createBot() {
  if (!botRunning) return;
  if (isReconnecting) {
    addLog("[Bot] Already reconnecting, skipping...");
    return;
  }

  // Cleanup previous bot properly to avoid ghost bots
  if (bot) {
    clearAllIntervals();
    disposeBot(bot);
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    const botVersion = resolveBotVersion();

    const thisBot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 120000,
      physicsEnabled: !botState.safeMode,
    });
    thisBot.physicsEnabled = !botState.safeMode;
    bot = thisBot;
    if (botState.safeMode) addLog("[Bot] Static mode: physics disabled, no movement packets will be sent");

    installPacketGuard(thisBot);
    thisBot.loadPlugin(pathfinder);

    // Connection timeout - dispose the half-open bot before reconnecting (no ghost bots)
    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      connectionTimeoutId = null;
      if (!botState.connected && bot === thisBot) {
        addLog("[Bot] Connection timeout - no spawn received");
        disposeBot(thisBot);
        bot = null;
        scheduleReconnect();
      }
    }, 150000); // Aternos can take 90-120s to finish spawning a player

    // guard against spawn firing twice (can happen on some servers)
    let spawnHandled = false;

    thisBot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.connectedAt = Date.now();
      botState.lastActivity = Date.now();
      isReconnecting = false;

      addLog(`[Bot] [+] Successfully spawned on server! (Version: ${thisBot.version})`);
      botState.plannedLeave = false;

      const lr = config["leave-rejoin"];
      if (lr.enabled) {
        const stayMs = Math.max(0.1, Number(lr["stay-minutes"]) || 30) * 60 * 1000;
        botState.nextLeaveAt = Date.now() + stayMs;
        leaveTimeoutId = setTimeout(() => {
          leaveTimeoutId = null;
          if (bot !== thisBot || !botState.connected) return;
          addLog(`[Sleep] Stay time over - leaving the server for ${Number(lr["away-seconds"]) || 10}s`);
          botState.plannedLeave = true;
          botState.nextLeaveAt = 0;
          clearAllIntervals();
          try {
            thisBot.quit("Scheduled rest");
          } catch (e) {
            addLog(`[Sleep] Quit error: ${e.message}`);
            botState.plannedLeave = false;
          }
        }, stayMs);
        addLog(`[Sleep] Will leave in ${Math.round(stayMs / 60000)} min, rejoin ${Number(lr["away-seconds"]) || 10}s later`);
      }
      if (config.discord.events.connect) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);
      }

      thisBot.on("messagestr", (message) => {
        if (
          message.includes("commands.gamemode.success.self") ||
          message.includes("Set own game mode to Creative Mode")
        ) {
          addLog("[INFO] Bot is now in Creative Mode.");
        }
      });

      // Start movement/anti-AFK only once the world is loaded. Sending move/look packets
      // while chunks are still streaming in is a common source of invalid-move kicks.
      (async () => {
        await waitUntilWorldReady(thisBot);
        if (bot !== thisBot || !botState.connected) {
          addLog("[Bot] Connection ended before modules started - skipping init");
          return;
        }

        const mcData = require("minecraft-data")(thisBot.version);
        const defaultMove = new Movements(thisBot, mcData);
        defaultMove.allowFreeMotion = false;
        defaultMove.canDig = false;
        defaultMove.liquidCost = 1000;
        defaultMove.fallDamageCost = 1000;

        initializeModules(thisBot, mcData, defaultMove);

        // Attempt creative mode (only works if bot has OP and enabled in settings)
        if (config.server["try-creative"]) {
          setTimeout(() => {
            if (bot === thisBot && botState.connected) {
              thisBot.chat("/gamemode creative");
              addLog("[INFO] Attempted to set creative mode (requires OP)");
            }
          }, 3000);
        }
      })().catch((err) => addLog(`[Bot] Module init failed: ${err.message}`));
    });

    // 'kicked' fires before 'end'; 'end' is the single reconnect trigger.
    thisBot.on("kicked", (reason) => {
      const kickReason = typeof reason === "object" ? JSON.stringify(reason) : String(reason);
      addLog(`[Bot] Kicked: ${kickReason}`);
      botState.connected = false;
      pushError({ type: "kicked", reason: kickReason });
      clearAllIntervals();

      const reasonStr = kickReason.toLowerCase();
      if (
        reasonStr.includes("throttl") ||
        reasonStr.includes("wait before reconnect") ||
        reasonStr.includes("too fast")
      ) {
        addLog("[Bot] Throttle kick detected - will use extended reconnect delay");
        botState.wasThrottled = true;
      }
      if (reasonStr.includes("invalid_player_movement") || reasonStr.includes("invalid move")) {
        addLog("[Bot] Server rejected a movement packet - next join uses static mode (physics off)");
        botState.safeMode = true;
      }

      if (config.discord.events.disconnect) {
        sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
      }
    });

    thisBot.on("end", (reason) => {
      if (bot !== thisBot) return; // stale bot, already replaced/stopped
      addLog(`[Bot] Disconnected: ${reason || "Unknown reason"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;

      // Only forget past failures if the connection was actually stable for a while.
      // (Resetting on every spawn caused an endless fast kick/rejoin loop.)
      if (botState.connectedAt && Date.now() - botState.connectedAt > 60000) {
        botState.reconnectAttempts = 0;
      }
      botState.connectedAt = 0;
      clearLeaveTimer();

      if (botState.plannedLeave) {
        // Planned rest: rejoin after exactly "away-seconds", no backoff, not counted as a failure
        botState.plannedLeave = false;
        botState.reconnectAttempts = 0;
        const awayMs = Math.max(1, Number(config["leave-rejoin"]["away-seconds"]) || 10) * 1000;
        scheduleReconnect(awayMs);
        return;
      }

      if (config.discord.events.disconnect) {
        sendDiscordWebhook(`[-] **Disconnected**: ${reason || "Unknown"}`, 0xf87171);
      }

      scheduleReconnect();
    });

    thisBot.on("error", (err) => {
      const msg = (err && err.message) || String(err);
      addLog(`[Bot] Error: ${msg}`);
      pushError({ type: "error", message: msg });
      if (!botState.useNewestSupported && /unsupported|not supported|no data for|unknown version/i.test(msg)) {
        botState.useNewestSupported = true;
        addLog("[Version] Server version not supported by installed mineflayer - next attempt uses fallback version");
      }
      // 'end' will follow and handle the reconnect
    });
  } catch (err) {
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect(fixedDelayMs) {
  if (!botRunning) {
    addLog("[Bot] Bot is stopped - not reconnecting.");
    return;
  }
  if (config.utils["auto-reconnect"] === false) {
    addLog("[Bot] auto-reconnect is disabled in settings.json - not reconnecting.");
    return;
  }
  // Don't stack reconnects (and don't cancel the one that's already pending)
  if (isReconnecting) {
    addLog("[Bot] Reconnect already scheduled, skipping duplicate.");
    return;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }

  isReconnecting = true;
  let delay;
  if (fixedDelayMs) {
    delay = fixedDelayMs;
    addLog(`[Sleep] Sleeping ${Math.round(delay / 1000)}s, then rejoining`);
  } else {
    botState.reconnectAttempts++;
    delay = getReconnectDelay();
    addLog(`[Bot] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${botState.reconnectAttempts})`);
  }

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing all modules...");

  // ---------- AUTO AUTH (REACTIVE) ----------
  if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      if (type === "register") {
        bot.chat(`/register ${password} ${password}`);
        addLog("[Auth] Detected register prompt - sent /register");
      } else {
        bot.chat(`/login ${password}`);
        addLog("[Auth] Detected login prompt - sent /login");
      }
    };

    bot.on("messagestr", (message) => {
      if (authHandled) return;
      if (/^<[^>]+>/.test(message)) return; // ignore normal player chat
      const msg = message.toLowerCase();
      if (
        msg.includes("/register") ||
        msg.includes("register ") ||
        msg.includes("지정된 비밀번호")
      ) {
        tryAuth("register");
      } else if (
        msg.includes("/login") ||
        msg.includes("login ") ||
        msg.includes("로그인")
      ) {
        tryAuth("login");
      }
    });

    // Failsafe: if no prompt after 10s, try login anyway
    setTimeout(() => {
      if (!authHandled && bot && botState.connected) {
        addLog(
          "[Auth] No prompt detected after 10s, sending /login as failsafe",
        );
        bot.chat(`/login ${password}`);
        authHandled = true;
      }
    }, 10000);
  }

  // ---------- CHAT MESSAGES ----------
  if (config.utils["chat-messages"].enabled) {
    const messages = (config.utils["chat-messages"].messages || []).filter(Boolean);
    if (config.utils["chat-messages"].repeat && messages.length) {
      // repeat-delay is in SECONDS. Values that are obviously milliseconds are converted, and the
      // result is clamped to 30s..24h - an oversized delay overflows setInterval (max ~24.8 days)
      // and makes Node fire it every 1 ms, which spams the chat and gets the bot kicked.
      let delaySec = Number(config.utils["chat-messages"]["repeat-delay"]) || 600;
      if (delaySec > 86400) delaySec = delaySec / 1000;
      delaySec = Math.min(Math.max(delaySec, 30), 86400);
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, delaySec * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => {
          if (bot && botState.connected) bot.chat(msg);
        }, idx * 2000);
      });
    }
  }

  // ---------- MOVE TO POSITION ----------
  // FIX: only use position goal if circle-walk is NOT enabled (they fight over pathfinder)
  if (
    !botState.safeMode &&
    config.position &&
    config.position.enabled &&
    !(
      config.movement &&
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    )
  ) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(
      new GoalBlock(config.position.x, config.position.y, config.position.z),
    );
    addLog("[Position] Navigating to configured position...");
  }

  // ---------- ANTI-AFK ----------
  if (config.utils["anti-afk"].enabled) {
    const baseSneak = !botState.safeMode && !!config.utils["anti-afk"].sneak;
    const circleWalkOn = !!(config.movement["circle-walk"] && config.movement["circle-walk"].enabled);
    const canControl = () => bot && botState.connected && typeof bot.setControlState === "function";

    // Arm swinging
    addInterval(() => {
      if (!canControl()) return;
      try {
        bot.swingArm();
      } catch (e) {}
    }, 10000 + Math.floor(Math.random() * 50000));

    // Hotbar cycling
    addInterval(() => {
      if (!canControl()) return;
      try {
        bot.setQuickBarSlot(Math.floor(Math.random() * 9));
      } catch (e) {}
    }, 30000 + Math.floor(Math.random() * 90000));

    // Sneak "teabag" - always restores the configured sneak state afterwards
    addInterval(() => {
      if (!canControl() || botState.safeMode || Math.random() > 0.1) return;
      let count = 2 + Math.floor(Math.random() * 4);
      const doTeabag = () => {
        if (count <= 0 || !canControl()) {
          if (canControl()) bot.setControlState("sneak", baseSneak);
          return;
        }
        try {
          bot.setControlState("sneak", !baseSneak);
          setTimeout(() => {
            if (canControl()) bot.setControlState("sneak", baseSneak);
            count--;
            setTimeout(doTeabag, 150);
          }, 150);
        } catch (e) {}
      };
      doTeabag();
    }, 120000 + Math.floor(Math.random() * 180000));

    // Micro-walk only when circle-walk is NOT running (they would fight over the controls)
    if (!circleWalkOn && !botState.safeMode) {
      addInterval(() => {
        if (!canControl()) return;
        try {
          safeLook(bot, Math.random() * Math.PI * 2, 0, true);
          bot.setControlState("forward", true);
          setTimeout(() => {
            if (canControl()) bot.setControlState("forward", false);
          }, 500 + Math.floor(Math.random() * 1500));
          botState.lastActivity = Date.now();
        } catch (e) {
          addLog(`[AntiAFK] Walk error: ${e.message}`);
        }
      }, 120000 + Math.floor(Math.random() * 360000));
    }

    if (baseSneak && canControl()) {
      try {
        bot.setControlState("sneak", true);
      } catch (e) {}
    }
  }

  // ---------- MOVEMENT MODULES ----------
  // FIX: check top-level movement.enabled flag
  if (config.movement && config.movement.enabled !== false && !botState.safeMode) {
    // FIX: circle-walk and random-jump both jump - only run one jumping mechanism
    // random-jump is skipped if anti-afk jump is handled elsewhere; we only use random-jump here
    if (
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    ) {
      startCircleWalk(bot, defaultMove);
    }
    // FIX: only run random-jump if circle-walk is NOT running (circle-walk also keeps bot moving)
    if (
      config.movement["random-jump"] &&
      config.movement["random-jump"].enabled &&
      !(
        config.movement["circle-walk"] && config.movement["circle-walk"].enabled
      )
    ) {
      startRandomJump(bot);
    }
    if (
      config.movement["look-around"] &&
      config.movement["look-around"].enabled
    ) {
      startLookAround(bot);
    }
  }

  // ---------- CUSTOM MODULES ----------
  // FIX: avoidMobs AND combatModule conflict - if combat is enabled, don't run avoidMobs at the same time
  if (config.modules.avoidMobs && !config.modules.combat && !botState.safeMode) {
    avoidMobs(bot);
  }
  if (config.modules.combat) {
    combatModule(bot, mcData);
  }
  if (config.modules.beds) {
    bedModule(bot, mcData);
  }
  if (config.modules.chat) {
    chatModule(bot);
  }

  addLog("[Modules] All modules initialized!");
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function startCircleWalk(bot, defaultMove) {
  const cfg = config.movement["circle-walk"];
  const radius = Math.max(1, Number(cfg.radius) || 4);
  const everyMs = Math.max(1500, Number(cfg.speed) || 3000);
  // Walk around a FIXED centre (where the bot spawned). The old code re-centred on the bot's
  // current position every step, so it slowly drifted away from its starting point.
  const center = bot.entity.position.clone();
  let angle = 0;

  bot.pathfinder.setMovements(defaultMove);

  addInterval(() => {
    if (!bot || !botState.connected || !bot.entity) return;
    try {
      if (typeof bot.pathfinder.isMoving === "function" && bot.pathfinder.isMoving()) return;
      const x = Math.floor(center.x + Math.cos(angle) * radius);
      const z = Math.floor(center.z + Math.sin(angle) * radius);
      const y = Math.floor(bot.entity.position.y);
      if (![x, y, z].every(Number.isFinite)) return;
      bot.pathfinder.setGoal(new GoalBlock(x, y, z));
      angle = (angle + Math.PI / 4) % (Math.PI * 2);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog(`[CircleWalk] Error: ${e.message}`);
    }
  }, everyMs);
}

function startRandomJump(bot) {
  const everyMs = Math.max(2000, Number(config.movement["random-jump"].interval) || 10000);
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
    try {
      bot.setControlState("jump", true);
      setTimeout(() => {
        if (bot && typeof bot.setControlState === "function") bot.setControlState("jump", false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog(`[RandomJump] Error: ${e.message}`);
    }
  }, everyMs);
}

function startLookAround(bot) {
  const everyMs = Math.max(2000, Number(config.movement["look-around"].interval) || 5000);
  addInterval(() => {
    if (!bot || !botState.connected || !bot.entity) return;
    try {
      // don't fight the pathfinder while it is steering the bot
      if (bot.pathfinder && typeof bot.pathfinder.isMoving === "function" && bot.pathfinder.isMoving()) return;
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
      safeLook(bot, yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog(`[LookAround] Error: ${e.message}`);
    }
  }, everyMs);
}

// ============================================================
// CUSTOM MODULES
// ============================================================

// Avoid mobs/players
// FIX: e.username only exists on players; use e.name for mobs - now handled properly
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (
      !bot ||
      !botState.connected ||
      typeof bot.setControlState !== "function"
    )
      return;
    try {
      const entities = Object.values(bot.entities).filter(
        (e) =>
          e.type === "mob" ||
          (e.type === "player" && e.username !== bot.username),
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = bot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          bot.setControlState("back", true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === "function")
              bot.setControlState("back", false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      addLog(`[AvoidMobs] Error: ${e.message}`);
    }
  }, 2000);
}

// Combat module
// - only attacks HOSTILE mobs (the old code also hit villagers, pets, golems, ...)
// - respects the 1.9+ attack cooldown and sticks to one target for a few seconds
// - auto-eat never runs twice at once
function combatModule(bot, mcData) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;
  let isEating = false;

  const isHostile = (e) =>
    e && e.type === "mob" && e.position && (e.kind === "Hostile mobs" || e.kind === "Hostile");

  addInterval(() => {
    if (!bot || !botState.connected || !bot.entity) return;
    if (!config.combat["attack-mobs"]) return;

    const now = Date.now();
    if (now - lastAttackTime < 620) return;

    try {
      if (lockedTarget && now < lockedTargetExpiry && bot.entities[lockedTarget.id] && lockedTarget.position) {
        if (bot.entity.position.distanceTo(lockedTarget.position) < 4) {
          bot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        }
        lockedTarget = null;
      }

      const target = Object.values(bot.entities).find(
        (e) => isHostile(e) && bot.entity.position.distanceTo(e.position) < 4,
      );
      if (target) {
        lockedTarget = target;
        lockedTargetExpiry = now + 3000;
        bot.attack(target);
        lastAttackTime = now;
      }
    } catch (e) {
      addLog(`[Combat] Error: ${e.message}`);
    }
  }, 250);

  bot.on("health", () => {
    if (!config.combat["auto-eat"] || isEating) return;
    try {
      if (typeof bot.food === "number" && bot.food < 14) {
        const food = bot.inventory.items().find((i) => i.foodPoints && i.foodPoints > 0);
        if (food) {
          isEating = true;
          bot
            .equip(food, "hand")
            .then(() => bot.consume())
            .catch((e) => addLog(`[AutoEat] Error: ${e.message}`))
            .finally(() => {
              isEating = false;
            });
        }
      }
    } catch (e) {
      isEating = false;
      addLog(`[AutoEat] Error: ${e.message}`);
    }
  });
}

// Bed module
// FIX: bot.isSleeping can be stale; use a local isTryingToSleep guard to prevent double-sleep errors
// FIX: place-night was false in default settings - documentation note added
function bedModule(bot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!bot || !botState.connected) return;
    if (!config.beds["place-night"]) return; // FIX: check flag (was always skipping before)

    try {
      const isNight =
        bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;

      // FIX: use local guard instead of stale bot.isSleeping
      if (isNight && !isTryingToSleep) {
        const bedBlock = bot.findBlock({
          matching: (block) => block.name.includes("bed"),
          maxDistance: 8,
        });

        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await bot.sleep(bedBlock);
            addLog("[Bed] Sleeping...");
          } catch (e) {
            // Can't sleep - maybe not night enough or monsters nearby
          } finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      addLog(`[Bed] Error: ${e.message}`);
    }
  }, 10000);
}

// Chat module
// - greeting uses whole-word matching ("hi" no longer fires on "this"/"which")
// - replies are rate limited so the bot can't be made to spam itself into a kick
// - "!tp <player>" is limited to names listed in settings.json -> chat.admins
function chatModule(bot) {
  let lastReply = 0;
  const admins = (config.chat.admins || []).map((n) => String(n).toLowerCase());

  bot.on("chat", (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      if (config.discord.enabled && config.discord.events.chat) {
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
      }

      if (!config.chat.respond) return;

      const now = Date.now();
      if (/\b(hello|hi|hey)\b/i.test(message) && now - lastReply > 5000) {
        lastReply = now;
        bot.chat(`Hello, ${username}!`);
      }

      if (message.startsWith("!tp ") && admins.includes(username.toLowerCase())) {
        const target = message.split(" ")[1];
        if (target && /^[A-Za-z0-9_]{1,16}$/.test(target)) bot.chat(`/tp ${target}`);
      }
    } catch (e) {
      addLog(`[Chat] Error: ${e.message}`);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  if (!bot || !botState.connected) {
    addLog("[Console] Bot not connected");
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("say ")) {
    bot.chat(trimmed.slice(4));
  } else if (trimmed.startsWith("cmd ")) {
    bot.chat("/" + trimmed.slice(4));
  } else if (trimmed === "status") {
    addLog(
      `Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`,
    );
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// FIX: use Buffer.byteLength for Content-Length (handles non-ASCII usernames correctly)
// FIX: rate limiting to avoid spam when bot is flapping
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (
    !config.discord ||
    !config.discord.enabled ||
    !config.discord.webhookUrl ||
    config.discord.webhookUrl.includes("YOUR_DISCORD")
  )
    return;

  // FIX: Discord rate limiting - skip if sent too recently
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    addLog("[Discord] Rate limited - skipping webhook");
    return;
  }
  lastDiscordSend = now;

  const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [
      {
        description: content,
        color: color,
        timestamp: new Date().toISOString(),
        footer: { text: "Slobos AFK Bot" },
      },
    ],
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // FIX: use Buffer.byteLength instead of payload.length - handles non-ASCII (e.g. usernames with accents/emoji)
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    },
  };

  const req = protocol.request(options, (res) => {
    // Silent success
  });

  req.on("error", (e) => {
    addLog(`[Discord] Error sending webhook: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY - IMMORTAL MODE
// FIX: guard against uncaughtException stacking reconnects when isReconnecting is already true
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`);
  botState.errors.push({ type: "uncaught", message: msg, time: Date.now() });

  // Cap errors array to prevent memory leak over long uptimes
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("PartialReadError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timed out") ||
    msg.includes("write after end") ||
    msg.includes("This socket has been ended");

  if (isNetworkError) {
    addLog("[FATAL] Known network/protocol error - recovering gracefully...");
  }

  // ALWAYS recover — bot must never stay disconnected
  clearAllIntervals();
  botState.connected = false;

  // FIX: reset isReconnecting if it was stuck, then schedule reconnect
  if (isReconnecting) {
    addLog(
      "[FATAL] isReconnecting was stuck - resetting before crash recovery",
    );
    isReconnecting = false;
    // BUG FIX: was referencing non-existent 'reconnectTimeout' — correct name is 'reconnectTimeoutId'
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  setTimeout(
    () => {
      scheduleReconnect();
    },
    isNetworkError ? 5000 : 10000,
  );
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: "rejection", message: msg, time: Date.now() });
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("timed out") ||
    msg.includes("PartialReadError");

  if (isNetworkError && !isReconnecting && botRunning) {
    addLog("[FATAL] Network rejection — triggering reconnect...");
    clearAllIntervals();
    botState.connected = false;
    disposeBot(bot);
    bot = null;
    scheduleReconnect();
  }
});

// Graceful shutdown (hosts send SIGTERM on every redeploy/restart; ignoring it only delays a hard SIGKILL)
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  addLog(`[System] ${signal} received - shutting down gracefully`);
  botRunning = false;
  clearBotTimeouts();
  clearAllIntervals();
  disposeBot(bot);
  bot = null;
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// =============================
//===============================
// START THE BOT
// ============================================================
addLog("=".repeat(50));
addLog("  Minecraft AFK Bot v3.0");
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog("Version: auto-detect (latest from server)");
addLog(`Mode: ${botState.safeMode ? "static (physics off)" : "full physics"}`);
addLog(config["leave-rejoin"].enabled ? `Rest cycle: stay ${config["leave-rejoin"]["stay-minutes"]} min, away ${config["leave-rejoin"]["away-seconds"]}s` : "Rest cycle: disabled");
if (!DASHBOARD_PASSWORD) {
  addLog("[Security] DASHBOARD_PASSWORD is not set - the web dashboard/console is publicly accessible!");
}
addLog(
  `Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`,
);
addLog("=".repeat(50));

createBot();
