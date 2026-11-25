// Antigravity (IDE, CLI, ACP) keeps one SQLite database per conversation under
// ~/.gemini/antigravity*/conversations/<id>.db, with protobuf metadata blobs that
// carry per-generation token usage. Databases are re-read when they change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadStore, newThread, walkFiles } from '../threads.js';
import { openReadOnly } from '../sqlite.js';
import { decodeFields, fieldBytes, fieldBytesAll, fieldText, fieldVarint } from '../proto.js';

const ROOT_NAMES = ['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup', 'antigravity-acp'];
const ACTIVE_MS = 90 * 1000;

export function antigravityRoots(env = process.env) {
  if (env.ANTIGRAVITY_DATA_DIR) {
    return env.ANTIGRAVITY_DATA_DIR.split(',').map((d) => d.trim()).filter(Boolean).map((d) => {
      const conv = path.join(path.resolve(d), 'conversations');
      return fs.existsSync(conv) ? conv : path.resolve(d);
    });
  }
  const home = os.homedir();
  return [
    ...ROOT_NAMES.map((n) => path.join(home, '.gemini', n, 'conversations')),
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'antigravity', 'conversations'),
  ];
}

const MODEL_IDS = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-sonnet-4',
  282: 'claude-sonnet-4',
  290: 'claude-opus-4',
  291: 'claude-opus-4',
  333: 'claude-sonnet-4-5',
  334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5',
  341: 'claude-haiku-4-5',
  342: 'gpt-oss-120b-medium',
};

/** "Gemini 3 Pro (High)" -> "gemini-3-pro-high"; "Claude Sonnet 4.5 Thinking" -> "claude-sonnet-4.5". */
export function normalizeAntigravityModel(text, id, slug) {
  if (text) {
    const name = text.trim().toLowerCase().replace(/[()]/g, ' ').replace(/\bthinking\b/g, ' ').trim().replace(/\s+/g, '-');
    if (name && !/^model_placeholder/.test(name)) return name;
  }
  // Server-assigned MODEL_PLACEHOLDER_M<n> ids (1000+n) carry no meaning locally;
  // the real model slug is embedded next to `model_enum` in the same blob.
  if (slug) return slug;
  if (id && MODEL_IDS[id]) return MODEL_IDS[id];
  return id ? `antigravity-model-${id}` : null;
}

const SLUG_RE = /(gemini|claude|gpt|deepseek|glm|kimi|qwen|grok|mistral|llama)-[0-9a-z][-0-9a-z.]*/g;

/** Scans a metadata blob for the cascade model slug and the `model_enum` value.
 * Since the placeholder-enum migration the numeric model id is meaningless by
 * itself; the real slug (gemini-4-hydrogen, claude-sonnet-4-5, ...) sits in the
 * cascade metadata that is appended at the end of the blob, so the LAST slug
 * match wins — earlier hits are usually prompt/tool-description noise. */
export function blobModelInfo(blob) {
  if (!blob || !blob.length) return { slug: null, enumName: null };
  const txt = (Buffer.isBuffer(blob) ? blob : Buffer.from(blob)).toString('latin1');
  let slug = null;
  let m;
  SLUG_RE.lastIndex = 0;
  while ((m = SLUG_RE.exec(txt))) {
    if (m[0].length <= 40 && m[0] !== 'gemini-api') slug = m[0];
  }
  let enumName = null;
  const at = txt.indexOf('model_enum');
  if (at >= 0) {
    const em = /MODEL_[A-Z0-9_]{4,}/.exec(txt.slice(at + 10, at + 80));
    if (em) enumName = em[0];
  }
  return { slug, enumName };
}

function parseUsage(blob) {
  const f = decodeFields(blob);
  return {
    modelId: fieldVarint(f, 1) || null,
    input: fieldVarint(f, 2) || 0,
    output: fieldVarint(f, 3) || 0,
    cacheWrite: fieldVarint(f, 4) || 0,
    cacheRead: fieldVarint(f, 5) || 0,
    reasoning: fieldVarint(f, 9) || 0,
    visible: fieldVarint(f, 10) || 0,
    ids: [
      fieldText(f, 11) && `response:${fieldText(f, 11)}`,
      fieldText(f, 12) && `provider:${fieldText(f, 12)}`,
      fieldText(f, 7) && `message:${fieldText(f, 7)}`,
    ].filter(Boolean),
  };
}

function parseTimestamp(blob) {
  if (!blob) return null;
  const f = decodeFields(blob);
  const s = fieldVarint(f, 1);
  return s > 0 ? s * 1000 + Math.floor((fieldVarint(f, 2) || 0) / 1e6) : null;
}

const retryUsages = (fields, n) => fieldBytesAll(fields, n).map((b) => fieldBytes(decodeFields(b), 2)).filter(Boolean).map(parseUsage);

export function parseGeneration(blob) {
  const root = decodeFields(blob);
  const chat = fieldBytes(root, 1);
  if (!chat) return null;
  const f = decodeFields(chat);
  const gi = fieldBytes(f, 9);
  const steps = root.filter((x) => x.n === 2 && x.wire === 0).map((x) => Number(x.v));
  const info = blobModelInfo(blob);
  return {
    model: fieldText(f, 19) || fieldText(f, 21),
    modelId: fieldVarint(f, 3) || null,
    slug: info.slug,
    enumName: info.enumName,
    usage: fieldBytes(f, 4) ? parseUsage(fieldBytes(f, 4)) : null,
    retries: retryUsages(f, 17),
    ts: gi ? parseTimestamp(fieldBytes(decodeFields(gi), 4)) : null,
    steps,
  };
}

export function parseStep(blob) {
  const f = decodeFields(blob);
  const mi = fieldBytes(f, 24) ? decodeFields(fieldBytes(f, 24)) : [];
  const info = blobModelInfo(blob);
  return {
    model: fieldText(mi, 12) || fieldText(mi, 8),
    modelId: fieldVarint(mi, 1) || null,
    slug: info.slug,
    enumName: info.enumName,
    usage: fieldBytes(f, 9) ? parseUsage(fieldBytes(f, 9)) : null,
    retries: retryUsages(f, 28),
    ts: parseTimestamp(fieldBytes(f, 8) || fieldBytes(f, 1)),
  };
}

const toUsage = (u) => {
  const input = u.input + u.cacheRead + u.cacheWrite;
  const output = u.output || u.visible + u.reasoning;
  return { input, cached: u.cacheRead, cacheWrite: u.cacheWrite, output, reasoning: u.reasoning, total: input + output };
};

/** Reads one conversation database into usage events [{ ts, model, usage }]. */
export async function readConversation(file) {
  const db = await openReadOnly(file);
  if (!db) throw Object.assign(new Error('no SQLite backend (needs Node >= 22.13 or the sql.js package)'), { code: 'NO_SQLITE' });
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    if (!tables.has('gen_metadata')) return null;
    let trajectoryTs = null;
    if (tables.has('trajectory_metadata_blob')) {
      for (const r of db.all('SELECT data FROM trajectory_metadata_blob ORDER BY rowid ASC')) {
        try {
          trajectoryTs = trajectoryTs || parseTimestamp(fieldBytes(decodeFields(r.data), 2));
        } catch {}
      }
    }
    const rows = (sql, parse) =>
      db.all(sql).flatMap((r) => {
        try {
          const blob = r.data ?? r.metadata;
          return blob ? [{ idx: r.idx, ...parse(blob) }] : [];
        } catch {
          return [];
        }
      });
    const steps = tables.has('steps') ? rows('SELECT idx, metadata FROM steps ORDER BY idx ASC', parseStep) : [];
    const gens = rows('SELECT idx, data FROM gen_metadata ORDER BY idx ASC', parseGeneration);
    // Generation blobs carry the real model slug next to `model_enum`; step blobs
    // don't. Learn modelId/enum -> slug from generations so step-level usage
    // (whose usage blob only has the numeric modelId) resolves to real names too.
    const learned = new Map();
    for (const g of gens) {
      if (!g.slug) continue;
      for (const id of [g.modelId, g.usage?.modelId]) if (id) learned.set(id, g.slug);
      if (g.enumName) learned.set(g.enumName, g.slug);
    }
    const seen = new Set();
    const events = [];
    const stem = path.basename(file, '.db');
    let current = null;
    const push = (u, model, ts, fallback) => {
      if (!u) return;
      const usage = toUsage(u);
      if (!usage.total) return;
      const ids = u.ids.length ? u.ids : fallback;
      if (ids.some((id) => seen.has(id))) return;
      ids.forEach((id) => seen.add(id));
      events.push({ ts: ts || trajectoryTs || Date.now(), model: model || normalizeAntigravityModel(null, u.modelId, learned.get(u.modelId)) || 'gemini-internal-model', usage });
    };
    for (const s of steps) {
      const model = normalizeAntigravityModel(s.model, s.modelId, s.slug || learned.get(s.modelId) || learned.get(s.usage?.modelId));
      push(s.usage, model, s.ts, [`step:${stem}:${s.idx}`]);
      s.retries.forEach((u) => push(u, model, s.ts, []));
    }
    for (const g of gens) {
      const m = normalizeAntigravityModel(g.model, g.modelId || g.usage?.modelId, g.slug);
      if (m) current = m;
      const ids = g.steps.length ? g.steps.map((i) => `step:${stem}:${i}`) : [`gen:${stem}:${g.idx}`];
      push(g.usage, current, g.ts, ids);
      g.retries.forEach((u) => push(u, current, g.ts, []));
    }
    return { events: events.sort((a, b) => a.ts - b.ts), startedAt: trajectoryTs };
  } finally {
    db.close();
  }
}

const signature = (file) => {
  const st = (p) => {
    try {
      const s = fs.statSync(p);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return '-';
    }
  };
  return `${st(file)}|${st(`${file}-wal`)}`;
};

export class AntigravityStore extends ThreadStore {
  constructor({ roots = antigravityRoots(), sinceHours = 24, scanMs = 3000, pricingFile, pricing } = {}) {
    super({ sinceHours, pricingFile, pricing, providerId: 'antigravity' });
    this.roots_ = roots;
    this.scanMs = scanMs;
    this.sigs = new Map();
    this.errors = new Map();
    this.busy = null;
  }

  start() {
    this.refresh();
    this.timers.push(setInterval(() => this.refresh(), this.scanMs));
    return this;
  }

  async loadOnceAsync() {
    await this.refresh();
    return this;
  }

  listDatabases() {
    const cutoff = Date.now() - this.sinceMs;
    return this.roots_.flatMap((r) => walkFiles(r, /\.db$/, { maxDepth: 1 })).filter((p) => {
      try {
        const wal = fs.existsSync(`${p}-wal`) ? fs.statSync(`${p}-wal`).mtimeMs : 0;
        return Math.max(fs.statSync(p).mtimeMs, wal) >= cutoff;
      } catch {
        return false;
      }
    });
  }

  refresh() {
    if (this.busy) return this.busy;
    this.busy = this.refreshNow().finally(() => (this.busy = null));
    return this.busy;
  }

  async refreshNow() {
    let changed = false;
    const live = new Set();
    for (const file of this.listDatabases()) {
      const id = path.basename(file, '.db');
      live.add(id);
      const sig = signature(file);
      const prev = this.threads.get(id);
      if (this.sigs.get(file) === sig) {
        if (prev && prev.status === 'running' && Date.now() - (prev.updatedAt || 0) > ACTIVE_MS) {
          prev.status = 'done';
          changed = true;
        }
        continue;
      }
      this.sigs.set(file, sig);
      let conv;
      try {
        conv = await readConversation(file);
        this.errors.delete(file);
      } catch (e) {
        this.errors.set(file, e.message);
        continue;
      }
      if (!conv || !conv.events.length) continue;
      const t = newThread(id, file);
      t.sessionId = id;
      t.source = { kind: path.basename(path.dirname(path.dirname(file))).replace(/^\./, '') || 'antigravity' };
      t.provider = t.source.kind;
      t.startedAt = conv.startedAt || conv.events[0].ts;
      for (const ev of conv.events) {
        t.model = ev.model;
        this.applyDelta(t, ev.usage, ev.ts, ev.model);
        t.lastContextTokens = ev.usage.input;
      }
      let mtime = 0;
      try {
        mtime = Math.max(fs.statSync(file).mtimeMs, fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).mtimeMs : 0);
      } catch {}
      t.updatedAt = Math.max(t.updatedAt || 0, mtime);
      t.status = Date.now() - t.updatedAt < ACTIVE_MS ? 'running' : 'done';
      this.threads.set(id, t);
      changed = true;
    }
    for (const id of [...this.threads.keys()]) {
      if (!live.has(id)) {
        this.threads.delete(id);
        changed = true;
      }
    }
    if (changed) this.bump();
    return changed;
  }
}
