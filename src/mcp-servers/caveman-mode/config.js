/**
 * caveman-mode server configuration
 *
 * Config file location (in priority order):
 *   1. CAVEMAN_CONFIG env var
 *   2. ~/.local/share/caveman-mcp/server.config.json   (Linux/macOS)
 *   3. %APPDATA%\caveman-mcp\server.config.json         (Windows)
 *
 * Example config (MongoDB):
 *   { "storage": { "type": "mongodb", "mongoUrl": "mongodb://localhost:27017" } }
 *
 * Example config (JSON file):
 *   { "storage": { "type": "json" } }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname }  from 'path';
import { homedir, platform } from 'os';

function defaultConfigDir() {
  if (process.env.CAVEMAN_CONFIG) return dirname(process.env.CAVEMAN_CONFIG);
  if (platform() === 'win32') return join(process.env.APPDATA || homedir(), 'caveman-mcp');
  return join(homedir(), '.local', 'share', 'caveman-mcp');
}

export const CONFIG_DIR  = defaultConfigDir();
export const CONFIG_FILE = process.env.CAVEMAN_CONFIG || join(CONFIG_DIR, 'server.config.json');

export const DEFAULTS = {
  port:        3100,
  httpsPort:   3101,
  defaultMode: 'full',
  tlsCert:     null,   // auto-generated if null
  tlsKey:      null,
  storage: {
    type:            'json',                                        // 'json' | 'mongodb'
    jsonFile:        join(CONFIG_DIR, 'stats.json'),
    maxJsonRecords:  50000,                                         // cap for JSON file
    mongoUrl:        'mongodb://localhost:27017',
    mongoDb:         'caveman_mcp',
    mongoCollection: 'records',
  },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  // Write default config on first run
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
    console.log(`[config] created → ${CONFIG_FILE}`);
  }

  let file = {};
  try { file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { console.error('[config] parse error, using defaults:', e.message); }

  // Env var overrides (highest priority)
  const env = {};
  if (process.env.CAVEMAN_PORT)         env.port        = parseInt(process.env.CAVEMAN_PORT);
  if (process.env.CAVEMAN_HTTPS_PORT)   env.httpsPort   = parseInt(process.env.CAVEMAN_HTTPS_PORT);
  if (process.env.CAVEMAN_DEFAULT_MODE) env.defaultMode = process.env.CAVEMAN_DEFAULT_MODE.toLowerCase();
  if (process.env.CAVEMAN_TLS_CERT)     env.tlsCert     = process.env.CAVEMAN_TLS_CERT;
  if (process.env.CAVEMAN_TLS_KEY)      env.tlsKey      = process.env.CAVEMAN_TLS_KEY;
  if (process.env.CAVEMAN_STATS_FILE)   env.storage     = { ...env.storage, jsonFile: process.env.CAVEMAN_STATS_FILE };
  if (process.env.CAVEMAN_MONGO_URL) {
    env.storage = { ...env.storage, type: 'mongodb', mongoUrl: process.env.CAVEMAN_MONGO_URL };
  }

  return deepMerge(deepMerge(DEFAULTS, file), env);
}
