#!/usr/bin/env node
// caveman-usage-reporter — Stop hook
//
// Fires after every Claude Code response. Reads the session transcript,
// extracts the latest assistant message token counts, then POSTs to the
// caveman-mode MCP server /record endpoint so the dashboard updates in real time.
//
// Install in ~/.claude/settings.json:
//   "hooks": {
//     "Stop": [{
//       "matcher": "",
//       "hooks": [{
//         "type": "command",
//         "command": "node /path/to/caveman_mcp/src/hooks/caveman-usage-reporter.js"
//       }]
//     }]
//   }
//
// Env:
//   CAVEMAN_MCP_URL   base URL of caveman-mode server (default: http://localhost:3100)

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const https = require('https');
const { readFlag } = require('./caveman-config');

const MCP_URL  = (process.env.CAVEMAN_MCP_URL || 'http://localhost:3100').replace(/\/$/, '');
const STATE_FILE = path.join(os.homedir(), '.local', 'share', 'caveman-mcp', 'hook-state.json');

// ── State: track how many assistant turns we have already reported per session ─
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

// ── Parse transcript ───────────────────────────────────────────────────────────
function parseTranscript(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return []; }

  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const usage = entry.message.usage;
    if (!usage) continue;
    turns.push({
      input_tokens:  (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      output_tokens: usage.output_tokens || 0,
      model:         entry.message.model || null,
    });
  }
  return turns;
}

// ── HTTP POST ─────────────────────────────────────────────────────────────────
function post(url, body) {
  return new Promise((resolve) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      rejectUnauthorized: false, // allow self-signed cert
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.write(payload);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Read hook input from stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData = {};
  try { hookData = JSON.parse(input); } catch {}

  const { session_id, transcript_path } = hookData;
  if (!transcript_path || !session_id) process.exit(0);
  if (!fs.existsSync(transcript_path))  process.exit(0);

  // Parse all assistant turns in transcript
  const turns = parseTranscript(transcript_path);
  if (!turns.length) process.exit(0);

  // Load state to find unreported turns
  const state      = loadState();
  const reported   = state[session_id] || 0;
  const newTurns   = turns.slice(reported);
  if (!newTurns.length) process.exit(0);

  // Determine caveman mode from flag file
  const claudeDir  = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const flagPath   = path.join(claudeDir, '.caveman-active');
  let caveman_on   = false;
  let mode         = 'off';
  try {
    const flag = fs.readFileSync(flagPath, 'utf8').trim();
    if (flag && flag !== 'off') { caveman_on = true; mode = flag; }
  } catch {}

  // POST each unreported turn
  for (const turn of newTurns) {
    await post(`${MCP_URL}/record`, {
      session_id,
      input_tokens:  turn.input_tokens,
      output_tokens: turn.output_tokens,
      caveman_on,
      mode,
    });
  }

  // Persist updated reported count
  state[session_id] = turns.length;
  // Prune old sessions (keep last 200)
  const keys = Object.keys(state);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) delete state[k];
  }
  saveState(state);
}

main().catch(() => {}).finally(() => process.exit(0));
