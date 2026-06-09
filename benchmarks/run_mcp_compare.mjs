#!/usr/bin/env node
/**
 * MCP server ON vs OFF benchmark — all modes.
 *
 * 1. Spawns caveman-mode server locally (once)
 * 2. For each mode: connects via SSE, receives actual `instructions` from initialize
 * 3. Measures rule-based compression using those instructions as system prompt
 * 4. Measures baseline (no MCP / no instructions)
 * 5. Prints per-mode comparison table + Mermaid chart source
 *
 * Usage:
 *   node benchmarks/run_mcp_compare.mjs               # all modes
 *   node benchmarks/run_mcp_compare.mjs --mode ultra  # single mode
 *   node benchmarks/run_mcp_compare.mjs --port 3101
 */

import { spawn }  from 'child_process';
import http       from 'http';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const REPO        = join(__dirname, '..');
const SERVER_BIN  = join(REPO, 'src', 'mcp-servers', 'caveman-mode', 'index.js');
const RESULTS_DIR = join(__dirname, 'results');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };
const PORT   = +(getArg('--port') || 3101);
const SINGLE = getArg('--mode');

const ALL_MODES = ['lite','full','ultra','wenyan-lite','wenyan-full','wenyan-ultra'];
const MODES = SINGLE ? [SINGLE] : ALL_MODES;

// ── Token approximation ───────────────────────────────────────────────────────
const approxTokens = s => Math.round(s.length / 4);

// ── Sample responses ──────────────────────────────────────────────────────────
const SAMPLES = [
  { id: 'react-rerender',         text: `The issue you're experiencing is actually caused by the fact that you are creating a new object reference on every render. When you pass an object as a prop, React basically does a shallow comparison of the references, and since a new object is created on every single render, it's always going to see it as a change, which means it will re-render the component.\n\nThe simplest way to fix this is to wrap the object in a \`useMemo\` hook:\n\`\`\`jsx\nconst myObj = useMemo(() => ({ key: value }), [value]);\n\`\`\`\nYou should also consider using \`React.memo\` to wrap the child component so it will only re-render when its props actually change.` },
  { id: 'auth-middleware-fix',    text: `The problem you are running into is actually a units mismatch. The JWT \`exp\` field is a Unix timestamp in seconds, but \`Date.now()\` returns milliseconds. So your comparison is essentially checking whether the token expires before the year 33658 AD.\n\nHere is the fix:\n\`\`\`js\nconst now = Math.floor(Date.now() / 1000);\nif (decoded.exp < now) { return res.status(401).json({ error: 'Token expired' }); }\n\`\`\`\nYou should also make sure you are handling the case where the \`exp\` field is simply missing from the token.` },
  { id: 'postgres-pool',          text: `Setting up a PostgreSQL connection pool in Node.js is fairly straightforward with the \`pg\` library:\n\`\`\`js\nconst { Pool } = require('pg');\nconst pool = new Pool({\n  connectionString: process.env.DATABASE_URL,\n  max: 10,\n  idleTimeoutMillis: 30000,\n  connectionTimeoutMillis: 2000,\n});\npool.on('error', (err) => { console.error('Unexpected error', err); process.exit(-1); });\n\`\`\`\nYou should generally make sure to release connections back to the pool after each query.` },
  { id: 'git-rebase-merge',       text: `Both \`git rebase\` and \`git merge\` are basically ways to integrate changes from one branch into another, but they work in fundamentally different ways.\n\n**Git merge** creates a new merge commit that ties together the histories of both branches. It's non-destructive.\n\n**Git rebase** replays your commits on top of another branch, resulting in a cleaner linear history, but rewrites commit history.\n\nThe golden rule is to never rebase commits that have already been pushed to a shared repository.` },
  { id: 'async-refactor',         text: `Here is the refactored version using async/await:\n\`\`\`js\nasync function getUser(id) {\n  const rows = await db.query('SELECT * FROM users WHERE id = ?', [id]);\n  if (!rows.length) throw new Error('Not found');\n  return rows[0];\n}\n\`\`\`\nThe callback parameter is completely removed since we're now returning a Promise. Error handling is done by simply throwing an error. The caller should use try/catch to handle errors.` },
  { id: 'microservices-monolith', text: `Before you start splitting up the monolith, there are several key factors you should really think through carefully.\n\n**Team factors:** Do you actually have separate teams that could own separate services? Conway's Law means your architecture will essentially mirror your team structure.\n\n**Hidden costs:** Network latency, data consistency across services, and debugging distributed systems is much harder than debugging a monolith. Consider a modular monolith first.` },
  { id: 'pr-security-review',     text: `This code has a critical SQL injection vulnerability. The route handler is directly interpolating user input into the SQL query string without any sanitization.\n\nHere is the corrected version:\n\`\`\`js\napp.get('/api/users/:id', async (req, res) => {\n  const user = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);\n  if (!user.rows.length) return res.status(404).json({ error: 'Not found' });\n  res.json(user.rows[0]);\n});\n\`\`\`` },
  { id: 'docker-multi-stage',     text: `Here is a multi-stage Dockerfile that keeps the final image as small as possible:\n\`\`\`dockerfile\nFROM node:20-alpine AS builder\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n\nFROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY --from=builder /app/dist ./dist\nUSER node\nCMD ["node", "dist/index.js"]\n\`\`\`` },
  { id: 'race-condition-debug',   text: `The problem you're experiencing is a classic race condition. Both requests read the counter before either writes back.\n\nFix with an atomic UPDATE:\n\`\`\`sql\nUPDATE counters SET value = value + 1 WHERE id = $1 RETURNING value;\n\`\`\`\nThis is guaranteed to be atomic at the database level, so concurrent requests will correctly serialize. Using the atomic single-statement UPDATE is generally preferable since it's simpler.` },
  { id: 'error-boundary',         text: `Here is a complete error boundary implementation:\n\`\`\`jsx\nclass ErrorBoundary extends React.Component {\n  state = { hasError: false, error: null };\n  static getDerivedStateFromError(e) { return { hasError: true, error: e }; }\n  componentDidCatch(e, info) { console.error('Caught:', e, info); }\n  handleRetry = () => this.setState({ hasError: false, error: null });\n  render() {\n    if (this.state.hasError) return (\n      <div><h2>Something went wrong</h2><button onClick={this.handleRetry}>Retry</button></div>\n    );\n    return this.props.children;\n  }\n}\n\`\`\`` },
];

// ── Rule-based compressor (mirrors server logic) ──────────────────────────────
const FILLER   = /\b(just|really|basically|actually|simply|essentially|generally|typically|usually|often|quite|very|pretty|rather|fairly|somewhat|certainly|definitely|absolutely|clearly|obviously|of course|sure|happy to|let me|in order to|at the end of the day|in fact)\b/gi;
const ARTICLES = /\b(a|an|the)\b/g;
const ABBREV   = { database:'DB',authentication:'auth',configuration:'config',function:'fn',implementation:'impl',request:'req',response:'res',application:'app',environment:'env',repository:'repo',parameter:'param',error:'err' };

function compress(text, mode) {
  if (mode === 'baseline') return text;
  const blocks = [];
  let out = text.replace(/```[\s\S]*?```/g, m => { blocks.push(m); return `\x00${blocks.length-1}\x00`; });
  out = out.replace(FILLER, ' ');
  if (!mode.endsWith('lite')) out = out.replace(ARTICLES, ' ');
  if (mode.endsWith('ultra')) for (const [w,a] of Object.entries(ABBREV)) out = out.replace(new RegExp(`\\b${w}\\b`,'gi'), a);
  out = out.replace(/ {2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  return out.replace(/\x00(\d+)\x00/g,(_,i)=>blocks[+i]);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────
function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_BIN], {
      env: { ...process.env, CAVEMAN_PORT: String(port) },
      stdio: 'ignore',
      detached: false,
    });
    proc.on('error', reject);

    let attempts = 0;
    const poll = setInterval(() => {
      if (++attempts > 30) { clearInterval(poll); reject(new Error('Server start timeout (9s)')); return; }
      const req = http.request({ hostname: 'localhost', port, path: '/health' }, res => {
        if (res.statusCode === 200) { clearInterval(poll); resolve(proc); }
        res.resume();
      });
      req.on('error', () => {});
      req.setTimeout(400, () => req.destroy());
      req.end();
    }, 300);
  });
}

function stopServer(proc) {
  return new Promise(resolve => {
    proc.once('exit', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 2000);
  });
}

// ── SSE handshake — get instructions from live server ────────────────────────
function fetchInstructions(port, mode) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSE handshake timeout (mode=${mode})`)), 8000);
    let buf = '', sessionId = null, done = false;

    const sseReq = http.request(
      { hostname: 'localhost', port, path: `/sse?mode=${mode}`, headers: { Accept: 'text/event-stream' } },
      res => {
        res.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();

          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();

            if (currentEvent === 'endpoint' && !sessionId) {
              try {
                sessionId = new URL('http://localhost' + data).searchParams.get('sessionId');
                const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize',
                  params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'bench', version:'1' } } });
                const post = http.request({
                  hostname:'localhost', port, method:'POST',
                  path:`/messages?sessionId=${sessionId}`,
                  headers:{ 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, r => r.resume());
                post.on('error', ()=>{});
                post.write(body); post.end();
              } catch {}
              continue;
            }

            if (currentEvent === 'message' && !done) {
              try {
                const d = JSON.parse(data);
                if (d.result?.instructions) {
                  done = true; clearTimeout(timer); sseReq.destroy();
                  resolve(d.result.instructions);
                }
              } catch {}
            }
          }
        });
        res.on('error', e => { clearTimeout(timer); reject(e); });
      }
    );
    sseReq.on('error', e => { clearTimeout(timer); reject(e); });
    sseReq.end();
  });
}

// ── Measure compression ───────────────────────────────────────────────────────
function measure(label, sysPrompt, compressMode) {
  const sysTokens = approxTokens(sysPrompt);
  const rows = SAMPLES.map(s => {
    const out  = compress(s.text, compressMode);
    const base = approxTokens(s.text);
    const tok  = approxTokens(out);
    return { id: s.id, base_tokens: base, out_tokens: tok, savings: +(1 - tok/base).toFixed(3) };
  });
  const avg = a => a.reduce((x,y)=>x+y,0)/a.length;
  return {
    label,
    sys_tokens:       sysTokens,
    avg_out_tokens:   Math.round(avg(rows.map(r=>r.out_tokens))),
    avg_savings_pct:  Math.round(avg(rows.map(r=>r.savings))*100),
    rows,
  };
}

// ── ASCII bar chart ───────────────────────────────────────────────────────────
function bar(pct, max = 15) {
  const filled = Math.round((pct / 10) * max);
  return '█'.repeat(filled) + '░'.repeat(max - filled);
}

// ── Print ─────────────────────────────────────────────────────────────────────
function printAll(baseline, results) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  caveman-mode MCP — mode comparison vs baseline');
  console.log('══════════════════════════════════════════════════════════════\n');

  const W = 14;
  const hdr = ['Mode','Sys tokens','Overhead','Avg output','Savings','Break-even'];
  console.log(`  ${'Mode'.padEnd(W)} ${'Sys tok'.padStart(8)} ${'Overhead'.padStart(9)} ${'Avg out'.padStart(9)} ${'Savings'.padStart(8)} ${'Break-even'.padStart(11)}`);
  console.log('  ' + '─'.repeat(W) + ' ' + '─'.repeat(8) + ' ' + '─'.repeat(9) + ' ' + '─'.repeat(9) + ' ' + '─'.repeat(8) + ' ' + '─'.repeat(11));

  // baseline row
  console.log(`  ${'○ baseline'.padEnd(W)} ${String(baseline.sys_tokens).padStart(8)} ${'—'.padStart(9)} ${String(baseline.avg_out_tokens).padStart(9)} ${'0%'.padStart(8)} ${'—'.padStart(11)}`);

  for (const r of results) {
    const overhead    = r.sys_tokens - baseline.sys_tokens;
    const savingPerMsg = baseline.avg_out_tokens - r.avg_out_tokens;
    const breakeven   = savingPerMsg > 0 ? Math.ceil(overhead / savingPerMsg) + ' msgs' : '∞';
    console.log(
      `  ${'● ' + r.label.padEnd(W-2)} ${String(r.sys_tokens).padStart(8)} ${('+'+overhead).padStart(9)} ${String(r.avg_out_tokens).padStart(9)} ${(r.avg_savings_pct+'%').padStart(8)} ${breakeven.padStart(11)}`
    );
  }

  console.log('\n── Savings % per mode (rule-based simulation) ──\n');
  for (const r of results) {
    const pct = r.avg_savings_pct;
    console.log(`  ${r.label.padEnd(14)} ${bar(pct)} ${pct}%`);
  }

  console.log('\n── Break-even: responses until MCP overhead paid back ──\n');
  for (const r of results) {
    const overhead    = r.sys_tokens - baseline.sys_tokens;
    const savingPerMsg = baseline.avg_out_tokens - r.avg_out_tokens;
    const be          = savingPerMsg > 0 ? Math.ceil(overhead / savingPerMsg) : 999;
    const barLen      = Math.round((be / 110) * 20);
    console.log(`  ${r.label.padEnd(14)} ${'▓'.repeat(Math.min(barLen,20))}${'░'.repeat(Math.max(0,20-barLen))} ${be === 999 ? '∞' : be + ' msgs'}`);
  }

  console.log('\n> Rule-based simulation (chars/4 ≈ tokens). Code blocks preserved.');
  console.log('> Real LLM savings: 65-75% (requires ANTHROPIC_API_KEY).\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\nStarting caveman-mode MCP server  modes=[${MODES.join(',')}]  port=${PORT} ...`);

let proc;
try {
  proc = await startServer(PORT);
  console.log(`Server started  (PID ${proc.pid})\n`);

  // baseline (no MCP)
  const baseline = measure('baseline', 'You are a helpful assistant.', 'baseline');
  console.log(`  baseline measured: ${baseline.sys_tokens} sys tokens, ${baseline.avg_out_tokens} avg out tokens`);

  const results = [];
  for (const mode of MODES) {
    process.stdout.write(`  ${mode.padEnd(14)} fetching instructions ... `);
    const instructions = await fetchInstructions(PORT, mode);
    const r = measure(mode, instructions, mode);
    results.push(r);
    console.log(`${r.sys_tokens} sys tokens, ${r.avg_savings_pct}% avg savings`);
  }

  printAll(baseline, results);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const path = join(RESULTS_DIR, `benchmark_mcp_compare_${ts}.json`);
  writeFileSync(path, JSON.stringify({ baseline, modes: results }, null, 2));
  console.log(`Results saved: ${path}`);

} finally {
  if (proc) {
    await stopServer(proc);
    console.log('Server stopped.');
  }
}
