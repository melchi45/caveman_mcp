#!/usr/bin/env node
/**
 * caveman-mode MCP server
 *
 * Default: HTTP/SSE mode (clients connect via URL)
 *   node index.js                    → port 3100
 *   node index.js --port 4000        → port 4000
 *
 * Stdio mode (client spawns as subprocess):
 *   node index.js --stdio
 *
 * Env:
 *   CAVEMAN_DEFAULT_MODE   lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra (default: full)
 *   CAVEMAN_PORT           HTTP port override (default: 3100)
 */

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport }   from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express              from 'express';
import { readFileSync }     from 'fs';
import { join, dirname }    from 'path';
import { fileURLToPath }    from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..', '..', '..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const STDIO = args.includes('--stdio');
const PORT  = (() => {
  const i = args.indexOf('--port');
  return i !== -1 ? parseInt(args[i + 1], 10) : parseInt(process.env.CAVEMAN_PORT || '3100', 10);
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

// ── MCP Server factory ────────────────────────────────────────────────────────
// sessionMode: per-session override from ?mode= query param (falls back to DEFAULT_MODE)
function createServer(sessionMode = DEFAULT_MODE) {
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
  // Stdio mode: single server, client spawns this process
  const server = createServer();
  await server.connect(new StdioServerTransport());

} else {
  // HTTP/SSE mode: Express app, each client session = new Server instance
  const app = express();
  // Do NOT use express.json() globally — SSEServerTransport.handlePostMessage
  // reads the raw request stream itself. Pre-consuming the body causes 400.

  // Map sessionId → SSEServerTransport
  const sessions = new Map();

  // SSE endpoint — client connects here to establish session
  // Optional ?mode= query param sets caveman intensity for this session only.
  // e.g. "url": "http://localhost:3100/sse?mode=ultra"
  app.get('/sse', async (req, res) => {
    const qmode      = (req.query.mode || '').toLowerCase();
    const sessionMode = VALID_MODES.includes(qmode) ? qmode : DEFAULT_MODE;
    const transport  = new SSEServerTransport('/messages', res);
    const server     = createServer(sessionMode);
    sessions.set(transport.sessionId, transport);

    // Heartbeat every 25s — prevents proxy/OS from closing idle SSE connections
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25000);

    res.on('close', () => {
      clearInterval(heartbeat);
      sessions.delete(transport.sessionId);
    });

    await server.connect(transport);
  });

  // POST endpoint — client sends JSON-RPC messages here
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

  app.listen(PORT, () => {
    console.log(`caveman-mode MCP server running on http://localhost:${PORT}`);
    console.log(`  SSE endpoint : http://localhost:${PORT}/sse`);
    console.log(`  Health check : http://localhost:${PORT}/health`);
    console.log(`  Default mode : ${DEFAULT_MODE}`);
  });
}
