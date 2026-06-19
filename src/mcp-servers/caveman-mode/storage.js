/**
 * caveman-mode storage backends
 *
 * Exports: createStorage(config) → Storage instance
 *
 * Backends:
 *   JsonStorage   — all records stored in a JSON file, aggregated in-memory
 *   MongoStorage  — records stored in MongoDB, aggregated via pipeline
 *
 * Both implement the same interface:
 *   await storage.init()
 *   await storage.addRecord(record)
 *   await storage.getStats(range)   // range: 'all'|'1d'|'1w'|'1m'|'1y'
 *   await storage.getRecent(n)
 *   await storage.close()
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Savings ratios from benchmark results (output token reduction per mode)
export const BENCHMARK_SAVINGS = {
  lite: 0.03, full: 0.06, ultra: 0.06,
  'wenyan-lite': 0.03, 'wenyan-full': 0.06, 'wenyan-ultra': 0.06,
};

export function calcSavings(d) {
  if (d.on_count > 0 && d.off_count > 0) {
    const avgOn  = d.on_output  / d.on_count;
    const avgOff = d.off_output / d.off_count;
    if (avgOff === 0) return { pct: 0, saved: 0, source: 'measured' };
    const pct   = Math.max(0, (avgOff - avgOn) / avgOff * 100);
    const saved = Math.max(0, Math.round((avgOff - avgOn) * d.on_count));
    return { pct: +pct.toFixed(1), saved, source: 'measured' };
  }
  if (d.on_count > 0) {
    let wt = 0, total = 0;
    for (const [m, x] of Object.entries(d.by_mode || {})) {
      wt += (BENCHMARK_SAVINGS[m] || 0.06) * x.count; total += x.count;
    }
    const ratio = total > 0 ? wt / total : 0.06;
    const saved = Math.max(0, Math.round(d.on_output * ratio / (1 - ratio)));
    return { pct: +(ratio * 100).toFixed(1), saved, source: 'estimated' };
  }
  return { pct: 0, saved: 0, source: 'no data' };
}

function rangeToSince(range) {
  if (!range || range === 'all') return null;
  const now = new Date();
  switch (range) {
    case '1d': return new Date(now - 86400 * 1000);
    case '1w': return new Date(now - 7 * 86400 * 1000);
    case '1m': { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d; }
    case '1y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d; }
    default:   return null;
  }
}

// ── JsonStorage ────────────────────────────────────────────────────────────────
class JsonStorage {
  constructor(cfg) {
    this.file       = cfg.jsonFile;
    this.maxRecords = cfg.maxJsonRecords || 50000;
    this.records    = [];  // [{ts, session_id, ip, mode, caveman_on, input_tokens, output_tokens}]
  }

  async init() {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw.records)) {
          // New format
          this.records = raw.records;
        } else if (raw.by_ip || raw.recent) {
          // Migrate from old pre-aggregated format
          this.records = (raw.recent || []).map(r => ({
            ts:           r.ts,
            session_id:   r.session_id || 'migrated',
            ip:           r.ip,
            mode:         r.mode,
            caveman_on:   r.caveman_on,
            input_tokens: r.input_tokens  || 0,
            output_tokens:r.output_tokens || 0,
          }));
          console.log(`[storage] migrated ${this.records.length} records from old format`);
          this._persist();
        }
      } catch (e) {
        console.error('[storage] load error:', e.message);
      }
    }
    console.log(`[storage] json — ${this.records.length} records loaded from ${this.file}`);
  }

  async addRecord(record) {
    this.records.unshift(record);
    if (this.records.length > this.maxRecords) {
      this.records.length = this.maxRecords;
    }
    this._persist();
  }

  async getStats(range) {
    const since   = rangeToSince(range);
    const records = since
      ? this.records.filter(r => new Date(r.ts) >= since)
      : this.records;
    return this._aggregate(records);
  }

  async getRecent(n = 200) {
    return this.records.slice(0, n);
  }

  async close() {}

  _aggregate(records) {
    const byIp = {};
    for (const r of records) {
      if (!byIp[r.ip]) byIp[r.ip] = {
        first_seen: r.ts, last_seen: r.ts,
        on_count: 0, off_count: 0,
        on_input: 0, on_output: 0, off_input: 0, off_output: 0,
        sessions: new Set(), by_mode: {},
      };
      const d = byIp[r.ip];
      if (r.ts < d.first_seen) d.first_seen = r.ts;
      if (r.ts > d.last_seen)  d.last_seen  = r.ts;
      d.sessions.add(r.session_id);
      if (r.caveman_on) {
        d.on_count++; d.on_input += r.input_tokens; d.on_output += r.output_tokens;
        if (!d.by_mode[r.mode]) d.by_mode[r.mode] = { count: 0, output: 0 };
        d.by_mode[r.mode].count++; d.by_mode[r.mode].output += r.output_tokens;
      } else {
        d.off_count++; d.off_input += r.input_tokens; d.off_output += r.output_tokens;
      }
    }
    const result = {};
    for (const [ip, d] of Object.entries(byIp)) {
      result[ip] = { ...d, session_count: d.sessions.size };
      delete result[ip].sessions;
    }
    return { by_ip: result, recent: records.slice(0, 200) };
  }

  _persist() {
    try {
      writeFileSync(this.file, JSON.stringify({ records: this.records }));
    } catch (e) {
      console.error('[storage] write error:', e.message);
    }
  }
}

// ── MongoStorage ──────────────────────────────────────────────────────────────
class MongoStorage {
  constructor(cfg) {
    this.url        = cfg.mongoUrl;
    this.dbName     = cfg.mongoDb;
    this.colName    = cfg.mongoCollection;
    this.client     = null;
    this.col        = null;
  }

  async init() {
    let MongoClient;
    try {
      ({ MongoClient } = await import('mongodb'));
    } catch {
      throw new Error('mongodb package not installed — run: npm install mongodb');
    }
    this.client = new MongoClient(this.url);
    await this.client.connect();
    this.col = this.client.db(this.dbName).collection(this.colName);
    await this.col.createIndex({ ts: -1 });
    await this.col.createIndex({ ip: 1 });
    await this.col.createIndex({ session_id: 1 });
    const count = await this.col.countDocuments();
    console.log(`[storage] mongodb — ${count} records in ${this.dbName}.${this.colName}`);
  }

  async addRecord(record) {
    await this.col.insertOne({ ...record, ts: new Date(record.ts) });
  }

  async getStats(range) {
    const since = rangeToSince(range);
    const match = since ? { ts: { $gte: since } } : {};

    // Aggregate by IP
    const ipAgg = await this.col.aggregate([
      { $match: match },
      { $group: {
        _id:           '$ip',
        first_seen:    { $min: '$ts' },
        last_seen:     { $max: '$ts' },
        on_count:      { $sum: { $cond: ['$caveman_on', 1, 0] } },
        off_count:     { $sum: { $cond: ['$caveman_on', 0, 1] } },
        on_input:      { $sum: { $cond: ['$caveman_on', '$input_tokens', 0] } },
        on_output:     { $sum: { $cond: ['$caveman_on', '$output_tokens', 0] } },
        off_input:     { $sum: { $cond: [{ $not: '$caveman_on' }, '$input_tokens', 0] } },
        off_output:    { $sum: { $cond: [{ $not: '$caveman_on' }, '$output_tokens', 0] } },
        session_set:   { $addToSet: '$session_id' },
      }},
    ]).toArray();

    // Mode breakdown (per IP)
    const modeAgg = await this.col.aggregate([
      { $match: { ...match, caveman_on: true } },
      { $group: {
        _id:    { ip: '$ip', mode: '$mode' },
        count:  { $sum: 1 },
        output: { $sum: '$output_tokens' },
      }},
    ]).toArray();

    const modeByIp = {};
    for (const m of modeAgg) {
      const ip = m._id.ip; const mode = m._id.mode;
      if (!modeByIp[ip]) modeByIp[ip] = {};
      modeByIp[ip][mode] = { count: m.count, output: m.output };
    }

    const by_ip = {};
    for (const doc of ipAgg) {
      by_ip[doc._id] = {
        first_seen:    doc.first_seen?.toISOString(),
        last_seen:     doc.last_seen?.toISOString(),
        on_count:      doc.on_count,
        off_count:     doc.off_count,
        on_input:      doc.on_input,
        on_output:     doc.on_output,
        off_input:     doc.off_input,
        off_output:    doc.off_output,
        session_count: doc.session_set?.length || 0,
        by_mode:       modeByIp[doc._id] || {},
      };
    }

    // Recent records
    const recent = await this.col
      .find(match, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(200)
      .toArray();

    return {
      by_ip,
      recent: recent.map(r => ({ ...r, ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts })),
    };
  }

  async getRecent(n = 200) {
    const docs = await this.col.find({}, { projection: { _id: 0 } }).sort({ ts: -1 }).limit(n).toArray();
    return docs.map(r => ({ ...r, ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts }));
  }

  async close() {
    await this.client?.close();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────
export async function createStorage(cfg) {
  let backend;
  if (cfg.type === 'mongodb') {
    backend = new MongoStorage(cfg);
  } else {
    backend = new JsonStorage(cfg);
  }
  await backend.init();
  return backend;
}
