#!/usr/bin/env node
/**
 * caveman-mode MCP server
 *
 * Default: HTTP + HTTPS mode
 *   node index.js                    → HTTP :3100, HTTPS :3443
 *   node index.js --port 4000        → HTTP :4000, HTTPS :4443
 *   node index.js --https-port 8443  → HTTPS :8443
 *   node index.js --no-http          → HTTPS only
 *
 * Stdio mode (client spawns as subprocess):
 *   node index.js --stdio
 *
 * Env:
 *   CAVEMAN_DEFAULT_MODE   lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra (default: full)
 *   CAVEMAN_PORT           HTTP port override (default: 3100)
 *   CAVEMAN_HTTPS_PORT     HTTPS port override (default: 3443)
 *   CAVEMAN_TLS_CERT       path to TLS certificate (PEM) — auto-generated if absent
 *   CAVEMAN_TLS_KEY        path to TLS private key (PEM) — auto-generated if absent
 *   CAVEMAN_STATS_FILE     override stats JSON path (default: ~/.local/share/caveman-mcp/stats.json)
 */

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport }        from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport }          from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express              from 'express';
import https                from 'https';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname }    from 'path';
import { fileURLToPath }    from 'url';
import { homedir }          from 'os';
import { randomUUID }       from 'crypto';
import { execSync }         from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..', '..', '..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const STDIO    = args.includes('--stdio');
const NO_HTTP  = args.includes('--no-http') || args.includes('--https-only');
const PORT     = (() => {
  const i = args.indexOf('--port');
  return i !== -1 ? parseInt(args[i + 1], 10) : parseInt(process.env.CAVEMAN_PORT || '3100', 10);
})();
const HTTPS_PORT = (() => {
  const i = args.indexOf('--https-port');
  return i !== -1 ? parseInt(args[i + 1], 10) : parseInt(process.env.CAVEMAN_HTTPS_PORT || '3101', 10);
})();

// ── Mode config ───────────────────────────────────────────────────────────────
const VALID_MODES = ['lite','full','ultra','wenyan-lite','wenyan-full','wenyan-ultra'];
const DEFAULT_MODE = (() => {
  const e = (process.env.CAVEMAN_DEFAULT_MODE || '').toLowerCase();
  return VALID_MODES.includes(e) ? e : 'full';
})();
let activeMode = DEFAULT_MODE;

// ── Skill loading ─────────────────────────────────────────────────────────────
function readSkill(name) {
  try { return readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); }
  catch { return ''; }
}
const SKILLS = { caveman: readSkill('caveman'), commit: readSkill('caveman-commit'), review: readSkill('caveman-review') };

function filterForMode(content, mode) {
  const label = mode === 'wenyan' ? 'wenyan-full' : mode;
  return content.split('\n').reduce((acc, line) => {
    const t = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (t) { if (t[1] === label) acc.push(line); return acc; }
    const e = line.match(/^- (\S+?):\s/);
    if (e) { if (e[1] === label) acc.push(line); return acc; }
    acc.push(line); return acc;
  }, []).join('\n');
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const STATS_FILE = process.env.CAVEMAN_STATS_FILE ||
  join(homedir(), '.local', 'share', 'caveman-mcp', 'stats.json');
const STATS_DIR  = dirname(STATS_FILE);
const MAX_RECENT = 200;

// Savings ratios from benchmark results (output token reduction)
const BENCHMARK_SAVINGS = {
  lite: 0.03, full: 0.06, ultra: 0.06,
  'wenyan-lite': 0.03, 'wenyan-full': 0.06, 'wenyan-ultra': 0.06,
};

// In-memory: unique sessions per IP (survives hot-reload, reset on process restart)
const ipSessionsSeen = new Map(); // ip -> Set<session_id>

let stats = (() => {
  try {
    if (existsSync(STATS_FILE)) {
      const raw = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
      // Restore ipSessionsSeen from persisted sessions arrays
      for (const [ip, d] of Object.entries(raw.by_ip || {})) {
        if (Array.isArray(d.sessions)) ipSessionsSeen.set(ip, new Set(d.sessions));
      }
      return raw;
    }
  } catch {}
  return { by_ip: {}, recent: [] };
})();

function persistStats() {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    const out = {
      by_ip: Object.fromEntries(
        Object.entries(stats.by_ip).map(([ip, d]) => [ip, {
          ...d,
          sessions: [...(ipSessionsSeen.get(ip) || new Set())],
        }])
      ),
      recent: stats.recent,
    };
    writeFileSync(STATS_FILE, JSON.stringify(out));
  } catch (e) {
    console.error('[stats] write failed:', e.message);
  }
}

function addRecord({ ts, session_id, ip, mode, caveman_on, input_tokens, output_tokens }) {
  if (!stats.by_ip[ip]) {
    stats.by_ip[ip] = {
      first_seen: ts, last_seen: ts,
      on_input: 0, on_output: 0, on_count: 0,
      off_input: 0, off_output: 0, off_count: 0,
      by_mode: {},
    };
  }
  const d = stats.by_ip[ip];
  d.last_seen = ts;

  if (!ipSessionsSeen.has(ip)) ipSessionsSeen.set(ip, new Set());
  ipSessionsSeen.get(ip).add(session_id);

  if (caveman_on) {
    d.on_input  += input_tokens;
    d.on_output += output_tokens;
    d.on_count++;
    if (!d.by_mode[mode]) d.by_mode[mode] = { count: 0, output: 0 };
    d.by_mode[mode].count++;
    d.by_mode[mode].output += output_tokens;
  } else {
    d.off_input  += input_tokens;
    d.off_output += output_tokens;
    d.off_count++;
  }

  stats.recent.unshift({ ts, ip, mode, caveman_on, input_tokens, output_tokens });
  if (stats.recent.length > MAX_RECENT) stats.recent.length = MAX_RECENT;

  persistStats();
}

function calcSavings(d) {
  if (d.on_count > 0 && d.off_count > 0) {
    const avgOn  = d.on_output  / d.on_count;
    const avgOff = d.off_output / d.off_count;
    if (avgOff === 0) return { pct: 0, saved: 0, source: 'measured' };
    const pct   = Math.max(0, (avgOff - avgOn) / avgOff * 100);
    const saved = Math.max(0, Math.round((avgOff - avgOn) * d.on_count));
    return { pct: +pct.toFixed(1), saved, source: 'measured' };
  }
  if (d.on_count > 0) {
    let wtRatio = 0, total = 0;
    for (const [mode, m] of Object.entries(d.by_mode || {})) {
      wtRatio += (BENCHMARK_SAVINGS[mode] || 0.06) * m.count;
      total   += m.count;
    }
    const ratio = total > 0 ? wtRatio / total : 0.06;
    const saved = Math.max(0, Math.round(d.on_output * ratio / (1 - ratio)));
    return { pct: +(ratio * 100).toFixed(1), saved, source: 'estimated' };
  }
  return { pct: 0, saved: 0, source: 'no data' };
}

// ── IP extraction ──────────────────────────────────────────────────────────────
function extractIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

// ── Dashboard HTML ─────────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function buildDashboard() {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const byIp = stats.by_ip;
  const ipEntries = Object.entries(byIp);

  // Global totals
  let totalOnCount = 0, totalOffCount = 0, totalSaved = 0;
  let totalOnInput = 0, totalOnOutput = 0;
  for (const [, d] of ipEntries) {
    const s = calcSavings(d);
    totalOnCount  += d.on_count;
    totalOffCount += d.off_count;
    totalSaved    += s.saved;
    totalOnInput  += d.on_input;
    totalOnOutput += d.on_output;
  }

  // Per-IP table rows
  const ipRows = ipEntries
    .sort((a, b) => (b[1].on_count + b[1].off_count) - (a[1].on_count + a[1].off_count))
    .map(([ip, d]) => {
      const s    = calcSavings(d);
      const sess = (ipSessionsSeen.get(ip) || new Set()).size;
      const barW = Math.min(100, Math.round(s.pct * 10));
      const badgeCls = s.source === 'measured' ? 'badge-measured' : 'badge-estimated';
      return `<tr>
        <td><code>${ip}</code></td>
        <td>${sess}</td>
        <td>${d.on_count}</td>
        <td>${d.off_count}</td>
        <td>${fmtNum(d.on_input + d.off_input)}</td>
        <td>${fmtNum(d.on_output)}</td>
        <td>
          <span class="green">${fmtNum(s.saved)}</span>
          <div class="bar-wrap"><div class="bar-fill" style="width:${barW}%"></div></div>
        </td>
        <td><span class="green">${s.pct}%</span></td>
        <td><span class="badge ${badgeCls}">${s.source}</span></td>
        <td style="color:#8b949e;font-size:11px">${d.last_seen?.slice(0,16).replace('T',' ')}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="10" class="empty">no data yet — call record_usage tool to start tracking</td></tr>`;

  // Per-mode aggregation
  const byMode = {};
  for (const [, d] of ipEntries) {
    for (const [mode, m] of Object.entries(d.by_mode || {})) {
      if (!byMode[mode]) byMode[mode] = { count: 0, output: 0 };
      byMode[mode].count  += m.count;
      byMode[mode].output += m.output;
    }
  }
  const modeRows = Object.entries(byMode)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([mode, m]) => {
      const ratio = BENCHMARK_SAVINGS[mode] || 0.06;
      const est   = Math.round(m.output * ratio / (1 - ratio));
      return `<tr>
        <td><code>${mode}</code></td>
        <td>${m.count}</td>
        <td>${fmtNum(m.output)}</td>
        <td><span class="green">${fmtNum(est)}</span></td>
        <td>${(ratio * 100).toFixed(0)}%</td>
      </tr>`;
    }).join('') || `<tr><td colspan="5" class="empty">no data yet</td></tr>`;

  // Recent activity
  const recentRows = stats.recent.slice(0, 50).map(r => {
    const cls = r.caveman_on ? 'badge-measured' : 'badge-off';
    const lbl = r.caveman_on ? `on:${r.mode}` : 'off';
    return `<tr>
      <td style="color:#8b949e;font-size:11px">${r.ts.slice(0,19).replace('T',' ')}</td>
      <td><code>${r.ip}</code></td>
      <td><span class="badge ${cls}">${lbl}</span></td>
      <td>${fmtNum(r.input_tokens)}</td>
      <td>${fmtNum(r.output_tokens)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">no activity yet</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>caveman-mcp dashboard</title>
  <meta http-equiv="refresh" content="30">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'SF Mono','Cascadia Code','Courier New',monospace;background:#0d1117;color:#c9d1d9;padding:24px;font-size:13px}
    h1{color:#f0883e;font-size:20px;margin-bottom:4px}
    .meta{color:#8b949e;font-size:11px;margin-bottom:20px}
    .meta a{color:#58a6ff;text-decoration:none}
    .meta a:hover{text-decoration:underline}
    .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:14px 18px;min-width:140px}
    .card-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.8px}
    .card-val{font-size:22px;font-weight:700;margin-top:6px}
    .blue{color:#58a6ff}.green{color:#3fb950}.orange{color:#f0883e}.purple{color:#bc8cff}
    h2{color:#f0883e;font-size:10px;text-transform:uppercase;letter-spacing:1.2px;margin:20px 0 8px;border-bottom:1px solid #21262d;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-bottom:8px}
    th{background:#161b22;color:#8b949e;text-align:left;padding:7px 10px;border-bottom:2px solid #30363d;font-size:10px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
    td{padding:7px 10px;border-bottom:1px solid #21262d}
    tr:hover td{background:#161b22}
    .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
    .badge-measured{background:#0d3320;color:#3fb950}
    .badge-estimated{background:#2d2a14;color:#e3b341}
    .badge-off{background:#1c1c1c;color:#8b949e}
    .bar-wrap{background:#21262d;border-radius:2px;height:5px;width:60px;display:inline-block;vertical-align:middle;margin-left:6px}
    .bar-fill{background:#3fb950;border-radius:2px;height:5px}
    .empty{color:#8b949e;font-style:italic;text-align:center;padding:16px}
    code{background:#161b22;padding:1px 5px;border-radius:3px;font-size:12px}
  </style>
</head>
<body>
  <h1>⛏ caveman-mcp</h1>
  <div class="meta">
    token savings dashboard &nbsp;·&nbsp; ${now} &nbsp;·&nbsp; auto-refresh 30s &nbsp;·&nbsp;
    <a href="/stats">JSON</a> &nbsp;·&nbsp; <a href="/health">health</a>
  </div>

  <div class="cards">
    <div class="card">
      <div class="card-label">requests (caveman on)</div>
      <div class="card-val blue">${fmtNum(totalOnCount)}</div>
    </div>
    <div class="card">
      <div class="card-label">output tokens saved</div>
      <div class="card-val green">${fmtNum(totalSaved)}</div>
    </div>
    <div class="card">
      <div class="card-label">total on output</div>
      <div class="card-val orange">${fmtNum(totalOnOutput)}</div>
    </div>
    <div class="card">
      <div class="card-label">requests (caveman off)</div>
      <div class="card-val purple">${fmtNum(totalOffCount)}</div>
    </div>
    <div class="card">
      <div class="card-label">unique IPs</div>
      <div class="card-val blue">${ipEntries.length}</div>
    </div>
  </div>

  <h2>by source IP</h2>
  <table>
    <thead><tr>
      <th>IP</th><th>sessions</th><th>on reqs</th><th>off reqs</th>
      <th>input tokens</th><th>on output</th><th>saved</th><th>savings %</th>
      <th>source</th><th>last seen</th>
    </tr></thead>
    <tbody>${ipRows}</tbody>
  </table>

  <h2>by mode</h2>
  <table>
    <thead><tr>
      <th>mode</th><th>requests</th><th>output tokens</th><th>est. saved</th><th>benchmark ratio</th>
    </tr></thead>
    <tbody>${modeRows}</tbody>
  </table>

  <h2>recent activity (last 50)</h2>
  <table>
    <thead><tr>
      <th>time (UTC)</th><th>IP</th><th>caveman</th><th>input tokens</th><th>output tokens</th>
    </tr></thead>
    <tbody>${recentRows}</tbody>
  </table>
</body>
</html>`;
}

// ── MCP Server factory ────────────────────────────────────────────────────────
function createServer(sessionMode = DEFAULT_MODE, meta = {}) {
  const ip        = meta.ip        || 'unknown';
  const sessionId = meta.sessionId || randomUUID();

  const server = new Server(
    { name: 'caveman-mode', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: `CAVEMAN MODE ACTIVE — level: ${sessionMode}\n\n${filterForMode(SKILLS.caveman, sessionMode)}`,
    }
  );

  // ── Tools ──────────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'activate_caveman',
        description: 'Activate caveman mode at the given intensity level. Returns the full ruleset. Apply to all subsequent responses.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: VALID_MODES, description: 'Intensity level (default: full)', default: 'full' },
          },
        },
      },
      { name: 'get_commit_rules',   description: 'Get caveman commit message rules (Conventional Commits, ≤50 char subject).', inputSchema: { type: 'object', properties: {} } },
      { name: 'get_review_rules',   description: 'Get caveman code review rules (one-line findings, severity-tagged).', inputSchema: { type: 'object', properties: {} } },
      { name: 'get_current_mode',   description: 'Return the currently active caveman mode.', inputSchema: { type: 'object', properties: {} } },
      { name: 'deactivate_caveman', description: 'Turn off caveman mode, return to normal prose.', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'record_usage',
        description: 'Report actual token usage after a Claude/Codex API call. Used to measure real savings per IP. Call after every response when caveman is active or inactive to build accurate comparison data.',
        inputSchema: {
          type: 'object',
          required: ['output_tokens'],
          properties: {
            input_tokens:  { type: 'number', description: 'Input tokens consumed in this request (from API usage field)' },
            output_tokens: { type: 'number', description: 'Output tokens in this response (from API usage field)' },
            caveman_on:    { type: 'boolean', description: 'Whether caveman was active for this response (default: true)' },
            mode:          { type: 'string',  description: 'Active caveman mode override (default: session mode)' },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    switch (name) {
      case 'activate_caveman': {
        const mode = (a?.mode || DEFAULT_MODE).toLowerCase();
        if (!VALID_MODES.includes(mode))
          return { isError: true, content: [{ type: 'text', text: `Invalid mode. Valid: ${VALID_MODES.join(', ')}` }] };
        activeMode = mode;
        return { content: [{ type: 'text', text: `CAVEMAN MODE ACTIVE — level: ${mode}\n\n${filterForMode(SKILLS.caveman, mode)}\n\nApply these rules to all responses.` }] };
      }
      case 'get_commit_rules':   return { content: [{ type: 'text', text: SKILLS.commit  || 'Not found.' }] };
      case 'get_review_rules':   return { content: [{ type: 'text', text: SKILLS.review  || 'Not found.' }] };
      case 'get_current_mode':   return { content: [{ type: 'text', text: `Active mode: ${activeMode}` }] };
      case 'deactivate_caveman': activeMode = 'off'; return { content: [{ type: 'text', text: 'Caveman deactivated. Normal prose resumed.' }] };
      case 'record_usage': {
        const input_tokens  = Math.max(0, parseInt(a?.input_tokens)  || 0);
        const output_tokens = Math.max(0, parseInt(a?.output_tokens) || 0);
        const caveman_on    = a?.caveman_on !== false;
        const mode = VALID_MODES.includes((a?.mode || '').toLowerCase())
          ? a.mode.toLowerCase() : sessionMode;
        addRecord({
          ts: new Date().toISOString(),
          session_id: sessionId,
          ip,
          mode,
          caveman_on,
          input_tokens,
          output_tokens,
        });
        return { content: [{ type: 'text', text: `recorded: in=${input_tokens} out=${output_tokens} caveman=${caveman_on} mode=${mode} ip=${ip}` }] };
      }
      default: return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  });

  // ── Resources ──────────────────────────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'caveman://rules',        name: 'Caveman Rules',        mimeType: 'text/markdown' },
      { uri: 'caveman://rules/commit', name: 'Caveman Commit Rules', mimeType: 'text/markdown' },
      { uri: 'caveman://rules/review', name: 'Caveman Review Rules', mimeType: 'text/markdown' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const map = { 'caveman://rules': SKILLS.caveman, 'caveman://rules/commit': SKILLS.commit, 'caveman://rules/review': SKILLS.review };
    const text = map[req.params.uri];
    if (!text) throw new Error(`Resource not found: ${req.params.uri}`);
    return { contents: [{ uri: req.params.uri, mimeType: 'text/markdown', text }] };
  });

  // ── Prompts ────────────────────────────────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: 'caveman',        description: 'Inject caveman rules for the given level.', arguments: [{ name: 'mode', required: false }] },
      { name: 'caveman_commit', description: 'Inject caveman commit message rules.' },
      { name: 'caveman_review', description: 'Inject caveman code review rules.' },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    switch (name) {
      case 'caveman': {
        const mode = VALID_MODES.includes((a?.mode || '').toLowerCase()) ? a.mode.toLowerCase() : DEFAULT_MODE;
        return { description: `Caveman — level: ${mode}`, messages: [{ role: 'user', content: { type: 'text', text: `CAVEMAN MODE ACTIVE — level: ${mode}\n\n${filterForMode(SKILLS.caveman, mode)}\n\nApply these rules from now on.` } }] };
      }
      case 'caveman_commit': return { description: 'Caveman commit rules', messages: [{ role: 'user', content: { type: 'text', text: SKILLS.commit } }] };
      case 'caveman_review': return { description: 'Caveman review rules', messages: [{ role: 'user', content: { type: 'text', text: SKILLS.review } }] };
      default: throw new Error(`Prompt not found: ${name}`);
    }
  });

  return server;
}

// ── Transport ─────────────────────────────────────────────────────────────────

if (STDIO) {
  const server = createServer();
  await server.connect(new StdioServerTransport());

} else {
  const app = express();
  const sessions = new Map(); // sessionId -> SSEServerTransport

  // SSE endpoint
  app.get('/sse', async (req, res) => {
    const qmode      = (req.query.mode || '').toLowerCase();
    const sessionMode = VALID_MODES.includes(qmode) ? qmode : DEFAULT_MODE;
    const ip         = extractIp(req);
    const transport  = new SSEServerTransport('/messages', res);
    const sessionId  = transport.sessionId;
    const server     = createServer(sessionMode, { ip, sessionId });
    sessions.set(sessionId, transport);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25000);

    res.on('close', () => {
      clearInterval(heartbeat);
      sessions.delete(sessionId);
    });

    await server.connect(transport);
  });

  // POST /sse — StreamableHTTP transport
  app.post('/sse', (req, res, next) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      try {
        const body      = raw ? JSON.parse(raw) : undefined;
        const qmode     = (req.query.mode || '').toLowerCase();
        const sessionMode = VALID_MODES.includes(qmode) ? qmode : DEFAULT_MODE;
        const ip        = extractIp(req);
        const sessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server    = createServer(sessionMode, { ip, sessionId });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) { next(e); }
    });
  });

  // POST /messages — legacy SSE
  app.post('/messages', async (req, res) => {
    const { sessionId } = req.query;
    const transport = sessions.get(sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res);
  });

  // Health check
  app.get('/health', (_req, res) => res.json({
    status: 'ok',
    server: 'caveman-mode',
    default_mode: DEFAULT_MODE,
    valid_modes: VALID_MODES,
    sse_endpoint: `http://localhost:${PORT}/sse`,
    usage: `Add ?mode=<level> to SSE URL to override mode per client session`,
  }));

  // Stats JSON
  app.get('/stats', (_req, res) => {
    const out = { by_ip: {}, recent: stats.recent, generated_at: new Date().toISOString() };
    for (const [ip, d] of Object.entries(stats.by_ip)) {
      out.by_ip[ip] = { ...d, savings: calcSavings(d), session_count: (ipSessionsSeen.get(ip) || new Set()).size };
    }
    res.json(out);
  });

  // Dashboard HTML
  app.get('/dashboard', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildDashboard());
  });

  // ── TLS ───────────────────────────────────────────────────────────────────
  const TLS_CERT = process.env.CAVEMAN_TLS_CERT || join(STATS_DIR, 'server.crt');
  const TLS_KEY  = process.env.CAVEMAN_TLS_KEY  || join(STATS_DIR, 'server.key');

  function ensureCert() {
    if (existsSync(TLS_CERT) && existsSync(TLS_KEY)) return;
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    console.log('[tls] generating self-signed certificate (10-year validity)...');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${TLS_KEY}" -out "${TLS_CERT}"` +
      ` -days 3650 -nodes -subj "/CN=localhost/O=caveman-mcp"`,
      { stdio: 'pipe' }
    );
    console.log(`[tls] cert → ${TLS_CERT}`);
    console.log(`[tls] key  → ${TLS_KEY}`);
  }

  function startHttps() {
    try {
      ensureCert();
      const tlsOptions = {
        cert: readFileSync(TLS_CERT),
        key:  readFileSync(TLS_KEY),
      };
      https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
        console.log(`  HTTPS SSE    : https://localhost:${HTTPS_PORT}/sse`);
        console.log(`  HTTPS dash   : https://localhost:${HTTPS_PORT}/dashboard`);
        console.log(`  TLS cert     : ${TLS_CERT}`);
      });
    } catch (e) {
      console.error(`[tls] HTTPS disabled: ${e.message}`);
    }
  }

  // ── Start servers ──────────────────────────────────────────────────────────
  if (!NO_HTTP) {
    app.listen(PORT, () => {
      console.log(`caveman-mode MCP server`);
      console.log(`  HTTP SSE     : http://localhost:${PORT}/sse`);
      console.log(`  HTTP dash    : http://localhost:${PORT}/dashboard`);
      console.log(`  Health       : http://localhost:${PORT}/health`);
      console.log(`  Stats JSON   : http://localhost:${PORT}/stats`);
      console.log(`  Default mode : ${DEFAULT_MODE}`);
      console.log(`  Stats file   : ${STATS_FILE}`);
    });
  }

  startHttps();
}
