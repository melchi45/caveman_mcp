#!/usr/bin/env node
/**
 * caveman-mode MCP server
 *
 * Default: HTTP :3100, HTTPS :3101
 *   node index.js                    → HTTP :3100 + HTTPS :3101
 *   node index.js --port 4000        → HTTP :4000
 *   node index.js --https-port 8443  → HTTPS :8443
 *   node index.js --no-http          → HTTPS only
 *   node index.js --stdio            → stdio mode
 *
 * Config file: ~/.local/share/caveman-mcp/server.config.json
 * Override:    CAVEMAN_CONFIG env var
 *
 * Quick MongoDB switch:
 *   CAVEMAN_MONGO_URL=mongodb://localhost:27017 node index.js
 */

import { Server }                        from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport }            from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express           from 'express';
import https             from 'https';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID }    from 'crypto';
import { execSync }      from 'child_process';

import { loadConfig, CONFIG_DIR, CONFIG_FILE } from './config.js';
import { createStorage, calcSavings, BENCHMARK_SAVINGS } from './storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..', '..', '..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const STDIO   = args.includes('--stdio');
const NO_HTTP = args.includes('--no-http') || args.includes('--https-only');

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

// ── Config ────────────────────────────────────────────────────────────────────
const cfg = loadConfig();

// CLI args override config file
if (getArg('--port'))       cfg.port      = parseInt(getArg('--port'));
if (getArg('--https-port')) cfg.httpsPort = parseInt(getArg('--https-port'));

const PORT        = cfg.port;
const HTTPS_PORT  = cfg.httpsPort;
const VALID_MODES = ['lite','full','ultra','wenyan-lite','wenyan-full','wenyan-ultra'];
const DEFAULT_MODE = VALID_MODES.includes(cfg.defaultMode) ? cfg.defaultMode : 'full';

let activeMode = DEFAULT_MODE;

// ── Skills ────────────────────────────────────────────────────────────────────
function readSkill(name) {
  try { return readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); }
  catch { return ''; }
}
const SKILLS = {
  caveman: readSkill('caveman'),
  commit:  readSkill('caveman-commit'),
  review:  readSkill('caveman-review'),
};

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

// ── Storage ───────────────────────────────────────────────────────────────────
let storage;
try {
  storage = await createStorage(cfg.storage);
} catch (e) {
  console.error('[storage] init failed:', e.message);
  if (cfg.storage.type === 'mongodb') {
    console.error('[storage] falling back to JSON storage');
    const { createStorage: cs } = await import('./storage.js');
    storage = await cs({ ...cfg.storage, type: 'json' });
  } else {
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function extractMode(req) {
  if (req.query.mode) return req.query.mode.toLowerCase();
  for (const key of Object.keys(req.query)) {
    try {
      const dec = decodeURIComponent(key);
      if (dec.startsWith('mode=')) return dec.slice(5).toLowerCase();
    } catch {}
  }
  return '';
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
function fmtNum(n) {
  n = n || 0;
  return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
}

function buildDashboard() {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>caveman-mcp dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'SF Mono','Cascadia Code','Courier New',monospace;background:#0d1117;color:#c9d1d9;padding:24px;font-size:13px}
    h1{color:#f0883e;font-size:20px;margin-bottom:4px;display:flex;align-items:center;gap:8px}
    .meta{color:#8b949e;font-size:11px;margin-bottom:12px}
    .meta a{color:#58a6ff;text-decoration:none}.meta a:hover{text-decoration:underline}
    .tabs{display:flex;gap:4px;margin-bottom:20px}
    .tab{padding:4px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;
         background:#161b22;border:1px solid #30363d;color:#8b949e;transition:all .15s}
    .tab.active{background:#f0883e22;border-color:#f0883e;color:#f0883e}
    .tab:hover:not(.active){background:#21262d;color:#c9d1d9}
    .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:14px 18px;min-width:140px}
    .card-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.8px}
    .card-val{font-size:22px;font-weight:700;margin-top:6px}
    .blue{color:#58a6ff}.green{color:#3fb950}.orange{color:#f0883e}.purple{color:#bc8cff}
    h2{color:#f0883e;font-size:10px;text-transform:uppercase;letter-spacing:1.2px;
       margin:20px 0 8px;border-bottom:1px solid #21262d;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-bottom:8px}
    th{background:#161b22;color:#8b949e;text-align:left;padding:7px 10px;
       border-bottom:2px solid #30363d;font-size:10px;text-transform:uppercase;
       letter-spacing:.5px;white-space:nowrap}
    td{padding:7px 10px;border-bottom:1px solid #21262d}
    tr:hover td{background:#161b22}
    .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
    .badge-measured{background:#0d3320;color:#3fb950}
    .badge-estimated{background:#2d2a14;color:#e3b341}
    .badge-off{background:#1c1c1c;color:#8b949e}
    .bar-wrap{background:#21262d;border-radius:2px;height:5px;width:60px;
              display:inline-block;vertical-align:middle;margin-left:6px}
    .bar-fill{background:#3fb950;border-radius:2px;height:5px}
    .empty{color:#8b949e;font-style:italic;text-align:center;padding:16px}
    code{background:#161b22;padding:1px 5px;border-radius:3px;font-size:12px}
    #dot{width:7px;height:7px;border-radius:50%;background:#3fb950;display:inline-block;transition:opacity .2s}
    #err{color:#f85149;font-size:11px;margin-left:8px;display:none}
  </style>
</head>
<body>
  <h1>⛏ caveman-mcp <span id="dot"></span><span id="err"></span></h1>
  <div class="meta">
    token savings dashboard &nbsp;·&nbsp; <span id="ts">${now}</span> &nbsp;·&nbsp; live&nbsp;1s &nbsp;·&nbsp;
    <a href="/stats">JSON</a> &nbsp;·&nbsp; <a href="/health">health</a>
  </div>

  <div class="tabs">
    <button class="tab active" data-range="all"  onclick="setRange('all')">ALL</button>
    <button class="tab"        data-range="1y"   onclick="setRange('1y')">1Y</button>
    <button class="tab"        data-range="1m"   onclick="setRange('1m')">1M</button>
    <button class="tab"        data-range="1w"   onclick="setRange('1w')">1W</button>
    <button class="tab"        data-range="1d"   onclick="setRange('1d')">1D</button>
  </div>

  <div class="cards">
    <div class="card"><div class="card-label">requests (caveman on)</div><div class="card-val blue"   id="c-on">—</div></div>
    <div class="card"><div class="card-label">output tokens saved</div> <div class="card-val green"  id="c-sv">—</div></div>
    <div class="card"><div class="card-label">total on output</div>     <div class="card-val orange" id="c-out">—</div></div>
    <div class="card"><div class="card-label">requests (caveman off)</div><div class="card-val purple"id="c-off">—</div></div>
    <div class="card"><div class="card-label">unique IPs</div>          <div class="card-val blue"   id="c-ip">—</div></div>
  </div>

  <h2>by source IP</h2>
  <table>
    <thead><tr><th>IP</th><th>sessions</th><th>on reqs</th><th>off reqs</th>
    <th>input tokens</th><th>on output</th><th>saved</th><th>savings %</th>
    <th>source</th><th>last seen</th></tr></thead>
    <tbody id="ip-tbody"><tr><td colspan="10" class="empty">loading…</td></tr></tbody>
  </table>

  <h2>by mode</h2>
  <table>
    <thead><tr><th>mode</th><th>requests</th><th>output tokens</th><th>est. saved</th><th>benchmark ratio</th></tr></thead>
    <tbody id="mode-tbody"><tr><td colspan="5" class="empty">loading…</td></tr></tbody>
  </table>

  <h2>recent activity (last 50)</h2>
  <table>
    <thead><tr><th>time</th><th>IP</th><th>caveman</th><th>input tokens</th><th>output tokens</th></tr></thead>
    <tbody id="rec-tbody"><tr><td colspan="5" class="empty">loading…</td></tr></tbody>
  </table>

<script>
const BENCH={lite:.03,full:.06,ultra:.06,'wenyan-lite':.03,'wenyan-full':.06,'wenyan-ultra':.06};
let activeRange='all', dotOn=true;

function fmt(n){
  n=n||0;
  return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);
}

function setRange(r){
  activeRange=r;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.range===r));
  tick();
}

async function tick(){
  try{
    const res=await fetch('/stats?range='+activeRange);
    if(!res.ok)throw new Error('HTTP '+res.status);
    const d=await res.json();
    const ips=Object.entries(d.by_ip||{});

    let onCnt=0,offCnt=0,saved=0,onOut=0;
    for(const[,v]of ips){
      onCnt +=v.on_count||0; offCnt+=v.off_count||0;
      saved +=v.savings?.saved||0; onOut +=v.on_output||0;
    }

    document.getElementById('c-on').textContent =fmt(onCnt);
    document.getElementById('c-sv').textContent =fmt(saved);
    document.getElementById('c-out').textContent=fmt(onOut);
    document.getElementById('c-off').textContent=fmt(offCnt);
    document.getElementById('c-ip').textContent =ips.length;
    document.getElementById('ts').textContent=new Date().toLocaleString();
    const dot=document.getElementById('dot');
    dot.style.opacity=(dotOn=!dotOn)?'1':'0.2';
    document.getElementById('err').style.display='none';

    // IP table
    document.getElementById('ip-tbody').innerHTML=ips.length
      ?ips.sort((a,b)=>(b[1].on_count+b[1].off_count)-(a[1].on_count+a[1].off_count))
         .map(([ip,v])=>{
           const s=v.savings||{pct:0,saved:0,source:'no data'};
           const bw=Math.min(100,Math.round(s.pct*10));
           const bc=s.source==='measured'?'badge-measured':'badge-estimated';
           return '<tr>'
             +'<td><code>'+ip+'</code></td><td>'+(v.session_count||0)+'</td>'
             +'<td>'+v.on_count+'</td><td>'+v.off_count+'</td>'
             +'<td>'+fmt((v.on_input||0)+(v.off_input||0))+'</td><td>'+fmt(v.on_output)+'</td>'
             +'<td><span class="green">'+fmt(s.saved)+'</span>'
             +'<div class="bar-wrap"><div class="bar-fill" style="width:'+bw+'%"></div></div></td>'
             +'<td><span class="green">'+s.pct+'%</span></td>'
             +'<td><span class="badge '+bc+'">'+s.source+'</span></td>'
             +'<td style="color:#8b949e;font-size:11px">'+(v.last_seen?new Date(v.last_seen).toLocaleString():'')+'</td>'
             +'</tr>';
         }).join('')
      :'<tr><td colspan="10" class="empty">no data for this period</td></tr>';

    // Mode table
    const bm={};
    for(const[,v]of ips)for(const[m,x]of Object.entries(v.by_mode||{})){
      if(!bm[m])bm[m]={count:0,output:0};
      bm[m].count+=x.count; bm[m].output+=x.output;
    }
    document.getElementById('mode-tbody').innerHTML=Object.keys(bm).length
      ?Object.entries(bm).sort((a,b)=>b[1].count-a[1].count)
         .map(([m,x])=>{
           const rt=BENCH[m]||.06;
           return '<tr><td><code>'+m+'</code></td><td>'+x.count+'</td><td>'+fmt(x.output)+'</td>'
             +'<td><span class="green">'+fmt(Math.round(x.output*rt/(1-rt)))+'</span></td>'
             +'<td>'+(rt*100).toFixed(0)+'%</td></tr>';
         }).join('')
      :'<tr><td colspan="5" class="empty">no data for this period</td></tr>';

    // Recent table
    const rec=(d.recent||[]).slice(0,50);
    document.getElementById('rec-tbody').innerHTML=rec.length
      ?rec.map(x=>{
          const cls=x.caveman_on?'badge-measured':'badge-off';
          const lbl=x.caveman_on?'on:'+x.mode:'off';
          return '<tr>'
            +'<td style="color:#8b949e;font-size:11px">'+new Date(x.ts).toLocaleString()+'</td>'
            +'<td><code>'+x.ip+'</code></td>'
            +'<td><span class="badge '+cls+'">'+lbl+'</span></td>'
            +'<td>'+fmt(x.input_tokens)+'</td><td>'+fmt(x.output_tokens)+'</td>'
            +'</tr>';
        }).join('')
      :'<tr><td colspan="5" class="empty">no activity in this period</td></tr>';

  }catch(e){
    const el=document.getElementById('err');
    el.textContent='⚠ '+e.message; el.style.display='inline';
  }
}

setInterval(tick,1000);
tick();
</script>
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
      capabilities:  { tools: {}, resources: {}, prompts: {} },
      instructions:  `CAVEMAN MODE ACTIVE — level: ${sessionMode}\n\n${filterForMode(SKILLS.caveman, sessionMode)}`,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'activate_caveman',
        description: 'Activate caveman mode at the given intensity level. Returns the full ruleset.',
        inputSchema: { type: 'object', properties: {
          mode: { type: 'string', enum: VALID_MODES, default: 'full' },
        }},
      },
      { name: 'get_commit_rules',   description: 'Get caveman commit message rules.', inputSchema: { type: 'object', properties: {} } },
      { name: 'get_review_rules',   description: 'Get caveman code review rules.',   inputSchema: { type: 'object', properties: {} } },
      { name: 'get_current_mode',   description: 'Return the currently active caveman mode.', inputSchema: { type: 'object', properties: {} } },
      { name: 'deactivate_caveman', description: 'Turn off caveman mode.',            inputSchema: { type: 'object', properties: {} } },
      {
        name: 'record_usage',
        description: 'Report actual token usage after a Claude/Codex API call. Feeds the savings dashboard.',
        inputSchema: { type: 'object', required: ['output_tokens'], properties: {
          input_tokens:  { type: 'number', description: 'Input tokens (from API usage field)' },
          output_tokens: { type: 'number', description: 'Output tokens (from API usage field)' },
          caveman_on:    { type: 'boolean', description: 'Whether caveman was active (default: true)' },
          mode:          { type: 'string',  description: 'Active mode (default: session mode)' },
        }},
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
        return { content: [{ type: 'text', text: `CAVEMAN MODE ACTIVE — level: ${mode}\n\n${filterForMode(SKILLS.caveman, mode)}\n\nApply to all responses.` }] };
      }
      case 'get_commit_rules':   return { content: [{ type: 'text', text: SKILLS.commit  || 'Not found.' }] };
      case 'get_review_rules':   return { content: [{ type: 'text', text: SKILLS.review  || 'Not found.' }] };
      case 'get_current_mode':   return { content: [{ type: 'text', text: `Active mode: ${activeMode}` }] };
      case 'deactivate_caveman': activeMode = 'off'; return { content: [{ type: 'text', text: 'Caveman deactivated.' }] };
      case 'record_usage': {
        const rec = {
          ts:            new Date().toISOString(),
          session_id:    sessionId,
          ip,
          mode:          VALID_MODES.includes((a?.mode || '').toLowerCase()) ? a.mode.toLowerCase() : sessionMode,
          caveman_on:    a?.caveman_on !== false,
          input_tokens:  Math.max(0, parseInt(a?.input_tokens)  || 0),
          output_tokens: Math.max(0, parseInt(a?.output_tokens) || 0),
        };
        await storage.addRecord(rec);
        return { content: [{ type: 'text', text: `recorded: in=${rec.input_tokens} out=${rec.output_tokens} caveman=${rec.caveman_on} ip=${ip}` }] };
      }
      default: return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  });

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

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: 'caveman',        description: 'Inject caveman rules.', arguments: [{ name: 'mode', required: false }] },
      { name: 'caveman_commit', description: 'Caveman commit rules.' },
      { name: 'caveman_review', description: 'Caveman review rules.' },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    switch (name) {
      case 'caveman': {
        const mode = VALID_MODES.includes((a?.mode || '').toLowerCase()) ? a.mode.toLowerCase() : DEFAULT_MODE;
        return { description: `Caveman — level: ${mode}`, messages: [{ role: 'user', content: { type: 'text', text: `CAVEMAN MODE ACTIVE — level: ${mode}\n\n${filterForMode(SKILLS.caveman, mode)}\n\nApply from now on.` } }] };
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
  const app      = express();
  const sessions = new Map();

  // CORS
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Cache-Control');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // SSE endpoint (GET)
  app.get('/sse', async (req, res) => {
    const qmode      = extractMode(req);
    const sessionMode = VALID_MODES.includes(qmode) ? qmode : DEFAULT_MODE;
    const ip         = extractIp(req);
    const transport  = new SSEServerTransport('/messages', res);
    const sessionId  = transport.sessionId;
    sessions.set(sessionId, transport);
    const server = createServer(sessionMode, { ip, sessionId });

    const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25000);
    res.on('close', () => { clearInterval(hb); sessions.delete(sessionId); });
    await server.connect(transport);
  });

  // SSE endpoint (POST — StreamableHTTP)
  app.post('/sse', (req, res, next) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      try {
        const body        = raw ? JSON.parse(raw) : undefined;
        const qmode       = extractMode(req);
        const sessionMode = VALID_MODES.includes(qmode) ? qmode : DEFAULT_MODE;
        const ip          = extractIp(req);
        const sessionId   = randomUUID();
        const transport   = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server      = createServer(sessionMode, { ip, sessionId });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) { next(e); }
    });
  });

  // Legacy SSE POST
  app.post('/messages', async (req, res) => {
    const transport = sessions.get(req.query.sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res);
  });

  // POST /record — hook-friendly REST (no MCP session needed)
  app.post('/record', express.json(), async (req, res) => {
    const { session_id, input_tokens, output_tokens, caveman_on, mode, ip: bodyIp } = req.body || {};
    const ip = bodyIp || extractIp(req);
    const rec = {
      ts:            new Date().toISOString(),
      session_id:    session_id   || randomUUID(),
      ip,
      mode:          VALID_MODES.includes((mode || '').toLowerCase()) ? mode.toLowerCase() : DEFAULT_MODE,
      caveman_on:    caveman_on !== false,
      input_tokens:  Math.max(0, parseInt(input_tokens)  || 0),
      output_tokens: Math.max(0, parseInt(output_tokens) || 0),
    };
    await storage.addRecord(rec);
    res.json({ ok: true, recorded: rec });
  });

  // Health
  app.get('/health', (_req, res) => res.json({
    status: 'ok', server: 'caveman-mode',
    default_mode: DEFAULT_MODE, valid_modes: VALID_MODES,
    storage: cfg.storage.type,
    sse_endpoint: `http://localhost:${PORT}/sse`,
  }));

  // Stats JSON (with time range)
  app.get('/stats', async (req, res) => {
    const range = req.query.range || 'all';
    const data  = await storage.getStats(range);
    // Attach savings calculation to each IP
    const out   = { by_ip: {}, recent: data.recent, range, generated_at: new Date().toISOString() };
    for (const [ip, d] of Object.entries(data.by_ip)) {
      out.by_ip[ip] = { ...d, savings: calcSavings(d) };
    }
    res.json(out);
  });

  // Dashboard HTML
  app.get('/dashboard', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildDashboard());
  });

  // ── TLS ────────────────────────────────────────────────────────────────────
  const TLS_CERT = cfg.tlsCert || join(CONFIG_DIR, 'server.crt');
  const TLS_KEY  = cfg.tlsKey  || join(CONFIG_DIR, 'server.key');

  function ensureCert() {
    if (existsSync(TLS_CERT) && existsSync(TLS_KEY)) return;
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    console.log('[tls] generating self-signed certificate...');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${TLS_KEY}" -out "${TLS_CERT}"` +
      ` -days 3650 -nodes -subj "/CN=localhost/O=caveman-mcp"`,
      { stdio: 'pipe' }
    );
    console.log(`[tls] cert → ${TLS_CERT}`);
  }

  function startHttps() {
    try {
      ensureCert();
      https.createServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, app)
        .listen(HTTPS_PORT, () => {
          console.log(`  HTTPS SSE    : https://localhost:${HTTPS_PORT}/sse`);
          console.log(`  HTTPS dash   : https://localhost:${HTTPS_PORT}/dashboard`);
        });
    } catch (e) {
      console.error(`[tls] HTTPS disabled: ${e.message}`);
    }
  }

  // ── Start ───────────────────────────────────────────────────────────────────
  if (!NO_HTTP) {
    app.listen(PORT, () => {
      console.log(`caveman-mode MCP server`);
      console.log(`  HTTP SSE     : http://localhost:${PORT}/sse`);
      console.log(`  HTTP dash    : http://localhost:${PORT}/dashboard`);
      console.log(`  Health       : http://localhost:${PORT}/health`);
      console.log(`  Stats JSON   : http://localhost:${PORT}/stats`);
      console.log(`  Default mode : ${DEFAULT_MODE}`);
      console.log(`  Storage      : ${cfg.storage.type}${cfg.storage.type === 'mongodb' ? ' (' + cfg.storage.mongoUrl + ')' : ''}`);
      console.log(`  Config       : ${CONFIG_FILE}`);
    });
  }

  startHttps();
}
