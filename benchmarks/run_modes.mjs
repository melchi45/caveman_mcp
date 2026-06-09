#!/usr/bin/env node
/**
 * Benchmark caveman-mode MCP — local tokenizer-free mode comparison.
 *
 * No API key, no external packages. Uses char/4 ≈ token approximation.
 *
 * Measures:
 *   1. System prompt overhead per mode (MCP `instructions` field size)
 *   2. Rule-based compression on sample responses (simulates LLM output)
 *   3. Projected savings per mode
 *
 * Usage:
 *   node benchmarks/run_modes.mjs [--json] [--modes m1,m2,...]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO      = join(__dirname, '..');
const SKILL_PATH = join(REPO, 'skills', 'caveman', 'SKILL.md');
const RESULTS_DIR = join(__dirname, 'results');

const ALL_MODES = ['baseline', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra'];

// ---------------------------------------------------------------------------
// Token approximation: chars / 4  (Claude BPE empirical average)
// ---------------------------------------------------------------------------
const approxTokens = (str) => Math.round(str.length / 4);

// ---------------------------------------------------------------------------
// SKILL.md loading & filtering (mirrors index.js logic exactly)
// ---------------------------------------------------------------------------
function stripFrontmatter(text) {
  return text.replace(/^---[\s\S]*?---\s*/, '');
}

function filterForMode(content, mode) {
  const label = mode === 'wenyan' ? 'wenyan-full' : mode;
  return content.split('\n').reduce((acc, line) => {
    const tableRow = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (tableRow) { if (tableRow[1] === label) acc.push(line); return acc; }
    const example = line.match(/^- (\S+?):\s/);
    if (example) { if (example[1] === label) acc.push(line); return acc; }
    acc.push(line);
    return acc;
  }, []).join('\n');
}

function buildSystemPrompt(mode, skillRaw) {
  if (mode === 'baseline') return 'You are a helpful assistant.';
  const body = stripFrontmatter(skillRaw);
  const filtered = filterForMode(body, mode);
  return `CAVEMAN MODE ACTIVE — level: ${mode}\n\n${filtered}`;
}

// ---------------------------------------------------------------------------
// Rule-based compressor — approximates what each mode tells the LLM to drop
// ---------------------------------------------------------------------------

// Words/phrases that caveman rules explicitly drop
const FILLER = [
  /\b(just|really|basically|actually|simply|essentially|generally|typically|usually|often|quite|very|pretty|rather|fairly|somewhat|certainly|definitely|absolutely|clearly|obviously|of course|sure|happy to|i(?:'d| would) be happy to|let me|in order to|please note that|it(?:'s| is) worth noting|it(?:'s| is) important to|you(?:'ll| will) want to|you(?:'re| are) going to|at the end of the day|in fact|as a matter of fact|in terms of|with respect to|with regard to)\b/gi,
  /\b(a|an|the)\b/g,   // articles (full + ultra only)
];

const FILLER_LITE = [FILLER[0]];      // no article removal
const FILLER_FULL = [FILLER[0], FILLER[1]];

// ultra: also abbreviate common tech terms
const ABBREV_MAP = {
  'database':       'DB',
  'databases':      'DBs',
  'authentication': 'auth',
  'configuration':  'config',
  'configurations': 'configs',
  'function':       'fn',
  'functions':      'fns',
  'implementation': 'impl',
  'request':        'req',
  'requests':       'reqs',
  'response':       'res',
  'responses':      'ress',
  'application':    'app',
  'applications':   'apps',
  'environment':    'env',
  'environments':   'envs',
  'repository':     'repo',
  'repositories':   'repos',
  'parameter':      'param',
  'parameters':     'params',
  'error':          'err',
  'errors':         'errs',
  'component':      'comp',
  'components':     'comps',
};

function applyAbbrev(text) {
  let out = text;
  for (const [word, abbr] of Object.entries(ABBREV_MAP)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), abbr);
  }
  return out;
}

function compress(text, mode) {
  if (mode === 'baseline') return text;

  // Preserve code blocks unchanged
  const blocks = [];
  let out = text.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `\x00CODE${blocks.length - 1}\x00`;
  });

  if (mode === 'lite') {
    for (const re of FILLER_LITE) out = out.replace(re, ' ');
  } else if (mode === 'full') {
    for (const re of FILLER_FULL) out = out.replace(re, ' ');
  } else if (mode === 'ultra') {
    for (const re of FILLER_FULL) out = out.replace(re, ' ');
    out = applyAbbrev(out);
  } else if (mode.startsWith('wenyan')) {
    // Wenyan: roughly similar to full prose removal; actual LLM would switch to classical Chinese.
    // We approximate as full compression for token-count purposes.
    for (const re of FILLER_FULL) out = out.replace(re, ' ');
    // wenyan-ultra: also remove conjunctions
    if (mode === 'wenyan-ultra') {
      out = out.replace(/\b(and|but|or|so|because|however|therefore|thus|hence|moreover|furthermore|additionally|also|although|though|while|whereas)\b/gi, ' ');
    }
  }

  // Collapse whitespace
  out = out.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Restore code blocks
  out = out.replace(/\x00CODE(\d+)\x00/g, (_, i) => blocks[+i]);

  return out;
}

// ---------------------------------------------------------------------------
// Sample responses — representative verbose coding-assistant outputs
// (10 tasks matching prompts.json)
// ---------------------------------------------------------------------------
const SAMPLES = [
  {
    id: 'react-rerender',
    category: 'debugging',
    response: `The issue you're experiencing is actually caused by the fact that you are creating a new object reference on every render. When you pass an object as a prop, React basically does a shallow comparison of the references, and since a new object is created on every single render, it's always going to see it as a change, which means it will re-render the component.

The simplest way to fix this is to wrap the object in a \`useMemo\` hook so that it only creates a new reference when the actual values change:

\`\`\`jsx
const myObj = useMemo(() => ({ key: value }), [value]);
\`\`\`

You should also consider using \`React.memo\` to wrap the child component so it will only re-render when its props actually change:

\`\`\`jsx
const MyComponent = React.memo(({ data }) => {
  return <div>{data.key}</div>;
});
\`\`\`

Additionally, if you are using a callback function as a prop, you will want to wrap it with \`useCallback\` to prevent the same issue from occurring with functions.`
  },
  {
    id: 'auth-middleware-fix',
    category: 'bugfix',
    response: `The problem you are running into is actually a units mismatch. The JWT \`exp\` field is a Unix timestamp in seconds, but \`Date.now()\` returns milliseconds. So your comparison is essentially checking whether the token expires before the year 33658 AD, which means expired tokens are always going to pass through.

Here is the fix:

\`\`\`js
const now = Math.floor(Date.now() / 1000);
if (decoded.exp < now) {
  return res.status(401).json({ error: 'Token expired' });
}
\`\`\`

You should also make sure you are handling the case where the \`exp\` field is simply missing from the token, as some JWT implementations do not include it by default. Additionally, consider using a well-tested library like \`jsonwebtoken\` which handles these edge cases for you automatically.`
  },
  {
    id: 'postgres-pool',
    category: 'setup',
    response: `Setting up a PostgreSQL connection pool in Node.js is fairly straightforward with the \`pg\` library. Here is a configuration that includes proper timeout and error handling:

\`\`\`js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                    // maximum number of connections
  idleTimeoutMillis: 30000,   // close idle connections after 30s
  connectionTimeoutMillis: 2000, // timeout if connection not acquired in 2s
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
\`\`\`

You should generally make sure to release connections back to the pool after each query by using \`pool.query()\` directly, or by explicitly calling \`client.release()\` if you acquire a client manually. It's also a good idea to set up a health check endpoint that verifies the database connection is still actually working.`
  },
  {
    id: 'git-rebase-merge',
    category: 'explanation',
    response: `Both \`git rebase\` and \`git merge\` are basically ways to integrate changes from one branch into another, but they work in fundamentally different ways and result in different histories.

**Git merge** creates a new "merge commit" that ties together the histories of both branches. It's a non-destructive operation — existing commits are never changed. The downside is that it can result in a rather cluttered history if you're merging frequently.

**Git rebase** moves or "replays" your commits on top of another branch, resulting in a cleaner, linear history. However, it actually rewrites the commit history by creating entirely new commits, which can cause problems if you're working on a shared branch.

**When to use each:**
- Use **merge** for integrating completed feature branches, for preserving the full history, or when working on shared/public branches
- Use **rebase** to keep a clean linear history on your local feature branch, or to update a feature branch with the latest changes from main before you open a pull request

The golden rule is to never rebase commits that have already been pushed to a shared repository, as this will cause serious problems for anyone else who has based their work on those commits.`
  },
  {
    id: 'async-refactor',
    category: 'refactor',
    response: `Here is the refactored version using async/await:

\`\`\`js
async function getUser(id) {
  const rows = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  if (!rows.length) throw new Error('Not found');
  return rows[0];
}
\`\`\`

The key things to note here are:
- The \`callback\` parameter is completely removed since we're now returning a Promise
- Error handling is done by simply throwing an error, which will cause the returned Promise to reject
- The caller should use try/catch or \`.catch()\` to handle errors
- \`db.query()\` needs to return a Promise for this to work — if it doesn't, you'll need to wrap it with \`util.promisify()\` first`
  },
  {
    id: 'microservices-monolith',
    category: 'architecture',
    response: `Before you start splitting up the monolith, there are several key factors you should really think through carefully.

**Team and organizational factors:**
- Do you actually have separate teams that could own separate services? Conway's Law means your architecture will essentially mirror your team structure
- Do you have the operational maturity to manage multiple deployments, service discovery, and distributed tracing?

**Technical factors:**
- Can you clearly identify bounded contexts — areas of the application that are truly independent?
- What are the actual bottlenecks? Microservices add a lot of complexity, so you should have a clear performance or scaling problem you're solving

**Hidden costs of microservices:**
- Network latency and the need to handle partial failures
- Data consistency across services becomes significantly more difficult
- Debugging distributed systems is much harder than debugging a monolith
- Each service needs its own CI/CD pipeline, monitoring, and infrastructure

**Alternatives to consider first:**
- Modular monolith — clean up internal boundaries without the operational overhead
- Vertical scaling — sometimes simply getting a bigger server is actually the right answer
- Database optimization — caching, read replicas, query optimization

In general, the recommendation would be to start by identifying the specific component that is causing the bottleneck, extract just that one piece first, and then evaluate whether the complexity trade-off was actually worth it before continuing.`
  },
  {
    id: 'pr-security-review',
    category: 'code-review',
    response: `This code has a critical SQL injection vulnerability. The route handler is directly interpolating user input from \`req.params.id\` into the SQL query string without any sanitization or parameterization whatsoever.

An attacker can simply pass a value like \`1 OR 1=1\` as the ID to dump all users, or use more sophisticated payloads to modify or delete data.

Here is the corrected version using parameterized queries:

\`\`\`js
app.get('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const user = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!user.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(user.rows[0]);
});
\`\`\`

Additional things you should address:
- Add input validation to ensure the ID is actually a valid integer before hitting the database
- Consider what fields are being returned — you probably don't want to expose password hashes or other sensitive fields in the response
- Add proper error handling so database errors don't leak internal details to the client`
  },
  {
    id: 'docker-multi-stage',
    category: 'devops',
    response: `Here is a multi-stage Dockerfile that keeps the final image as small as possible:

\`\`\`dockerfile
# Stage 1: Install dependencies and compile TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production=false

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine AS production
WORKDIR /app

# Only copy production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
\`\`\`

The key things that are happening here:
- The \`builder\` stage installs all dependencies (including dev dependencies) and compiles the TypeScript
- The \`production\` stage starts fresh from the base image and only installs production dependencies
- The compiled \`dist/\` directory is copied from the builder stage, so the TypeScript source and dev dependencies are not included in the final image
- Running as a non-root user with \`USER node\` is a security best practice you should always follow`
  },
  {
    id: 'race-condition-debug',
    category: 'debugging',
    response: `The problem you're experiencing is a classic race condition known as a "lost update". When two requests come in at roughly the same time, they both read the current value of the counter before either one has written its incremented value back. So they both increment the same original value and write the same result.

The correct way to fix this in PostgreSQL is to use an atomic UPDATE that increments in a single operation:

\`\`\`sql
UPDATE counters SET value = value + 1 WHERE id = $1 RETURNING value;
\`\`\`

This is guaranteed to be atomic at the database level, so concurrent requests will correctly serialize. If you need to ensure the update only happens under certain conditions, you can use \`SELECT ... FOR UPDATE\` to lock the row:

\`\`\`js
await db.query('BEGIN');
const { rows } = await db.query('SELECT value FROM counters WHERE id = $1 FOR UPDATE', [id]);
const newValue = rows[0].value + 1;
await db.query('UPDATE counters SET value = $1 WHERE id = $2', [newValue, id]);
await db.query('COMMIT');
\`\`\`

Using the atomic single-statement UPDATE is generally preferable since it's simpler and avoids the overhead of an explicit transaction for a simple increment operation.`
  },
  {
    id: 'error-boundary',
    category: 'implementation',
    response: `Here is a complete error boundary implementation with a retry button and error logging:

\`\`\`jsx
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    // Log to your error tracking service (e.g. Sentry)
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert">
          <h2>Something went wrong</h2>
          <pre>{this.state.error?.message}</pre>
          <button onClick={this.handleRetry}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
\`\`\`

A few things worth noting about this implementation:
- Error boundaries have to be class components — there is currently no hook equivalent for \`componentDidCatch\`
- The \`getDerivedStateFromError\` lifecycle method is what actually triggers the fallback UI render
- The retry simply resets the error state, which causes the children to re-render from scratch
- You should wrap this around individual sections of your UI rather than the entire application so that an error in one section doesn't bring down everything else`
  },
];

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { json: false, modes: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--modes') opts.modes = args[++i].split(',').map(s => s.trim());
    else { console.error(`Unknown arg: ${args[i]}`); process.exit(1); }
  }
  return opts;
}

const opts = parseArgs();
const modes = opts.modes ?? ALL_MODES;
const invalid = modes.filter(m => !ALL_MODES.includes(m));
if (invalid.length) {
  console.error(`Unknown modes: ${invalid}. Valid: ${ALL_MODES.join(', ')}`);
  process.exit(1);
}

const skillRaw = readFileSync(SKILL_PATH, 'utf8');
const systemPrompts = Object.fromEntries(modes.map(m => [m, buildSystemPrompt(m, skillRaw)]));

// ── Section 1: System prompt overhead (MCP instructions field) ──────────────
const syspromptRows = modes.map(m => {
  const sp = systemPrompts[m];
  return {
    mode:   m,
    chars:  sp.length,
    tokens: approxTokens(sp),
  };
});

// ── Section 2: Response compression per sample ──────────────────────────────
const compressionRows = SAMPLES.map(sample => {
  const row = { id: sample.id, category: sample.category };
  row.baseline_chars  = sample.response.length;
  row.baseline_tokens = approxTokens(sample.response);
  for (const mode of modes.filter(m => m !== 'baseline')) {
    const compressed = compress(sample.response, mode);
    row[`${mode}_chars`]   = compressed.length;
    row[`${mode}_tokens`]  = approxTokens(compressed);
    row[`${mode}_savings`] = +(1 - compressed.length / sample.response.length).toFixed(3);
  }
  return row;
});

// ── Section 3: Summary per mode ─────────────────────────────────────────────
const caveModes = modes.filter(m => m !== 'baseline');
const modeSummary = caveModes.map(mode => {
  const savings = compressionRows.map(r => r[`${mode}_savings`]);
  const avg = v => v.reduce((a, b) => a + b, 0) / v.length;
  const avgSavings = avg(savings);
  const avgOutTokens = Math.round(avg(compressionRows.map(r => r[`${mode}_tokens`])));
  const sysTokens = syspromptRows.find(r => r.mode === mode)?.tokens ?? 0;
  const baseTokens = syspromptRows.find(r => r.mode === 'baseline')?.tokens ?? 0;
  return {
    mode,
    sys_prompt_tokens:    sysTokens,
    sys_overhead_vs_base: sysTokens - baseTokens,
    avg_out_tokens:       avgOutTokens,
    avg_savings_pct:      Math.round(avgSavings * 100),
    min_savings_pct:      Math.round(Math.min(...savings) * 100),
    max_savings_pct:      Math.round(Math.max(...savings) * 100),
  };
});

// ── Output ──────────────────────────────────────────────────────────────────

if (opts.json) {
  const out = { system_prompts: syspromptRows, compression: compressionRows, summary: modeSummary };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(RESULTS_DIR, `benchmark_modes_${ts}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`Saved: ${path}`);
  process.exit(0);
}

// ── Pretty table output ──────────────────────────────────────────────────────

console.log('');
console.log('## 1. MCP instructions overhead (system prompt tokens per mode)');
console.log('');
console.log('| Mode | Chars | ~Tokens | Overhead vs baseline |');
console.log('|---|---:|---:|---:|');
for (const r of syspromptRows) {
  const baseTokens = syspromptRows.find(x => x.mode === 'baseline').tokens;
  const delta = r.mode === 'baseline' ? '—' : `+${r.tokens - baseTokens}`;
  console.log(`| ${r.mode} | ${r.chars} | ${r.tokens} | ${delta} |`);
}

console.log('');
console.log('## 2. Response compression per sample (rule-based, chars/4 ≈ tokens)');
console.log('');

const header = ['| Prompt', '| baseline'];
const sep    = ['|---',     '|---:'];
for (const m of caveModes) { header.push(`| ${m}`, '| saved'); sep.push('|---:', '|---:'); }
console.log(header.join('') + ' |');
console.log(sep.join('') + '|');

for (const r of compressionRows) {
  const label = r.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const cols = [`| ${label}`, `| ${r.baseline_tokens}`];
  for (const m of caveModes) {
    cols.push(`| ${r[`${m}_tokens`]}`, `| ${r[`${m}_savings`] * 100 | 0}%`);
  }
  console.log(cols.join('') + ' |');
}

// Average row
const avgBase = Math.round(compressionRows.reduce((s, r) => s + r.baseline_tokens, 0) / compressionRows.length);
const avgCols = ['| **Average**', `| **${avgBase}**`];
for (const m of caveModes) {
  const s = modeSummary.find(x => x.mode === m);
  avgCols.push(`| **${s.avg_out_tokens}**`, `| **${s.avg_savings_pct}%**`);
}
console.log(avgCols.join('') + ' |');

console.log('');
console.log('## 3. Mode comparison summary');
console.log('');
console.log('| Mode | Sys prompt tokens | Overhead | Avg output tokens | Avg savings | Range |');
console.log('|---|---:|---:|---:|---:|---|');
const baseRow = syspromptRows.find(r => r.mode === 'baseline');
console.log(`| baseline | ${baseRow.tokens} | — | ${avgBase} | 0% | — |`);
for (const s of modeSummary) {
  console.log(`| ${s.mode} | ${s.sys_prompt_tokens} | +${s.sys_overhead_vs_base} | ${s.avg_out_tokens} | ${s.avg_savings_pct}% | ${s.min_savings_pct}%–${s.max_savings_pct}% |`);
}

console.log('');
console.log('> Token counts: chars/4 approximation. Code blocks preserved unchanged across all modes.');
console.log('> Wenyan modes: approximated as full prose compression (actual LLM output would be classical Chinese).');
