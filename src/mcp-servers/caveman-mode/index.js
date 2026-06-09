#!/usr/bin/env node
// caveman-mode — MCP server that activates caveman communication mode.
//
// No installation required. Add to your MCP config and the server injects
// caveman rules automatically via the `instructions` field in the
// initialize response (most MCP clients surface this as system context).
//
// Claude Code config (~/.claude/settings.json):
//   "mcpServers": {
//     "caveman": {
//       "command": "npx",
//       "args": ["-y", "caveman-mode"]
//     }
//   }
//
// Copilot / other MCP clients: same config shape, different config file.
//
// Optional env vars:
//   CAVEMAN_DEFAULT_MODE   lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra (default: full)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve up to repo root: src/mcp-servers/caveman-mode/ → ../../../
const ROOT = join(__dirname, '..', '..', '..');

const VALID_MODES = [
  'lite', 'full', 'ultra',
  'wenyan-lite', 'wenyan-full', 'wenyan-ultra',
];

const DEFAULT_MODE = (() => {
  const env = (process.env.CAVEMAN_DEFAULT_MODE || '').toLowerCase();
  return VALID_MODES.includes(env) ? env : 'full';
})();

// Per-session active mode (in-memory; reset each server start)
let activeMode = DEFAULT_MODE;

// Read and strip frontmatter from a SKILL.md
function readSkill(name) {
  try {
    const raw = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    return raw.replace(/^---[\s\S]*?---\s*/, '');
  } catch {
    return '';
  }
}

const SKILLS = {
  caveman: readSkill('caveman'),
  commit:  readSkill('caveman-commit'),
  review:  readSkill('caveman-review'),
};

// Filter intensity table + examples to only the active mode row.
// Same logic as src/hooks/caveman-activate.js so behavior stays in sync.
function filterForMode(content, mode) {
  const label = mode === 'wenyan' ? 'wenyan-full' : mode;
  return content.split('\n').reduce((acc, line) => {
    const tableRow = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (tableRow) {
      if (tableRow[1] === label) acc.push(line);
      return acc;
    }
    const example = line.match(/^- (\S+?):\s/);
    if (example) {
      if (example[1] === label) acc.push(line);
      return acc;
    }
    acc.push(line);
    return acc;
  }, []).join('\n');
}

// The instructions string is returned in the MCP initialize response.
// Most MCP clients (Claude Code, Copilot, Cursor, etc.) inject it as
// system context automatically — this is the zero-install activation path.
const INSTRUCTIONS = `CAVEMAN MODE ACTIVE — level: ${DEFAULT_MODE}\n\n${filterForMode(SKILLS.caveman, DEFAULT_MODE)}`;

const server = new Server(
  { name: 'caveman-mode', version: '0.1.0' },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: INSTRUCTIONS,
  }
);

// ── Tools ────────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'activate_caveman',
      description: 'Activate caveman mode at the given intensity level. Returns the full ruleset for that level. Apply rules to all subsequent responses.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: VALID_MODES,
            description: 'Intensity level. Default: full.',
            default: 'full',
          },
        },
      },
    },
    {
      name: 'get_commit_rules',
      description: 'Get caveman-style commit message rules (Conventional Commits, ≤50 char subject, no fluff).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_review_rules',
      description: 'Get caveman-style code review rules (one-line findings, severity-tagged, no praise).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_current_mode',
      description: 'Return the currently active caveman mode for this session.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'deactivate_caveman',
      description: 'Turn off caveman mode and return to normal prose.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'activate_caveman': {
      const mode = ((args?.mode) || DEFAULT_MODE).toLowerCase();
      if (!VALID_MODES.includes(mode)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid mode "${mode}". Valid: ${VALID_MODES.join(', ')}` }],
        };
      }
      activeMode = mode;
      const rules = filterForMode(SKILLS.caveman, mode);
      return {
        content: [{
          type: 'text',
          text: `CAVEMAN MODE ACTIVE — level: ${mode}\n\n${rules}\n\nApply these rules to all responses for the rest of this conversation.`,
        }],
      };
    }

    case 'get_commit_rules':
      return {
        content: [{ type: 'text', text: SKILLS.commit || 'Commit skill not found.' }],
      };

    case 'get_review_rules':
      return {
        content: [{ type: 'text', text: SKILLS.review || 'Review skill not found.' }],
      };

    case 'get_current_mode':
      return {
        content: [{ type: 'text', text: `Active caveman mode: ${activeMode}` }],
      };

    case 'deactivate_caveman':
      activeMode = 'off';
      return {
        content: [{ type: 'text', text: 'Caveman mode deactivated. Return to normal prose.' }],
      };

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
  }
});

// ── Resources ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'caveman://rules',
      name: 'Caveman Rules',
      description: 'Full caveman communication ruleset (all intensity levels).',
      mimeType: 'text/markdown',
    },
    {
      uri: 'caveman://rules/commit',
      name: 'Caveman Commit Rules',
      description: 'Caveman commit message rules — Conventional Commits, terse subject.',
      mimeType: 'text/markdown',
    },
    {
      uri: 'caveman://rules/review',
      name: 'Caveman Review Rules',
      description: 'Caveman code review rules — one-line findings, severity tags.',
      mimeType: 'text/markdown',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const map = {
    'caveman://rules':        SKILLS.caveman,
    'caveman://rules/commit': SKILLS.commit,
    'caveman://rules/review': SKILLS.review,
  };
  const text = map[uri];
  if (text === undefined) {
    throw new Error(`Resource not found: ${uri}`);
  }
  return { contents: [{ uri, mimeType: 'text/markdown', text }] };
});

// ── Prompts ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'caveman',
      description: 'Inject caveman mode rules for the given intensity level.',
      arguments: [
        { name: 'mode', description: 'lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra', required: false },
      ],
    },
    {
      name: 'caveman_commit',
      description: 'Inject caveman commit message rules.',
    },
    {
      name: 'caveman_review',
      description: 'Inject caveman code review rules.',
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'caveman': {
      const mode = ((args?.mode) || DEFAULT_MODE).toLowerCase();
      const label = VALID_MODES.includes(mode) ? mode : DEFAULT_MODE;
      const rules = filterForMode(SKILLS.caveman, label);
      return {
        description: `Caveman mode — level: ${label}`,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `CAVEMAN MODE ACTIVE — level: ${label}\n\n${rules}\n\nApply these rules to all responses from now on.`,
          },
        }],
      };
    }

    case 'caveman_commit':
      return {
        description: 'Caveman commit message rules',
        messages: [{
          role: 'user',
          content: { type: 'text', text: SKILLS.commit },
        }],
      };

    case 'caveman_review':
      return {
        description: 'Caveman code review rules',
        messages: [{
          role: 'user',
          content: { type: 'text', text: SKILLS.review },
        }],
      };

    default:
      throw new Error(`Prompt not found: ${name}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
