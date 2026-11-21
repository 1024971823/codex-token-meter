// Tails Codex rollout files (~/.codex/sessions/**/rollout-*.jsonl) and keeps a live
// per-thread view of model + token usage, grouped into parent -> sub-agent trees.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const USAGE_KEYS = ['input', 'cached', 'cacheWrite', 'output', 'reasoning', 'total'];
const HISTORY_LIMIT = 120;

export function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export const emptyUsage = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });

export function normalizeUsage(u) {
  if (!u) return emptyUsage();
  return {
    input: u.input_tokens || 0,
    cached: u.cached_input_tokens || 0,
    cacheWrite: u.cache_write_input_tokens || 0,
    output: u.output_tokens || 0,
    reasoning: u.reasoning_output_tokens || 0,
    total: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0),
  };
}

export const addUsage = (a, b) => Object.fromEntries(USAGE_KEYS.map((k) => [k, (a[k] || 0) + (b[k] || 0)]));
const subUsage = (a, b) => Object.fromEntries(USAGE_KEYS.map((k) => [k, Math.max(0, (a[k] || 0) - (b[k] || 0))]));

function describeSource(source) {
  if (!source) return { kind: 'unknown' };
  if (typeof source === 'string') return { kind: source };
  if (source.subagent) {
    const sub = source.subagent;
    if (typeof sub === 'string') return { kind: 'subagent', subKind: sub };
    if (sub.thread_spawn) return { kind: 'subagent', subKind: 'thread_spawn', ...sub.thread_spawn };
    if (sub.other) return { kind: 'subagent', subKind: String(sub.other) };
    return { kind: 'subagent', subKind: Object.keys(sub)[0] };
  }
  if (source.custom) return { kind: String(source.custom) };
  if (source.internal) return { kind: 'internal', subKind: String(source.internal) };
  return { kind: Object.keys(source)[0] || 'unknown' };
}

function newThread(id, file) {
  return {
    id,
    file,
    sessionId: null,
    parentId: null,
    nickname: null,
    role: null,
    depth: 0,
    source: { kind: 'unknown' },
    cwd: null,
    provider: null,
    model: null,
    effort: null,
    contextWindow: null,
    usage: emptyUsage(),
    last: emptyUsage(),
    byModel: {},
    requests: 0,
    status: 'idle',
    startedAt: null,
    updatedAt: null,
    history: [],
    historyStart: null,
    hasUsageRecords: false,
  };
}

export class RolloutStore extends EventEmitter {
  constructor({ codexHome = defaultCodexHome(), sinceHours = 24, pollMs = 500, scanMs = 2000 } = {}) {
    super();
    this.codexHome = codexHome;
    this.sessionsDir = path.join(codexHome, 'sessions');
    this.sinceMs = sinceHours * 3600 * 1000;
    this.pollMs = pollMs;
    this.scanMs = scanMs;
    this.files = new Map(); // path -> { offset, buf, threadId, size }
    this.threads = new Map(); // threadId -> thread
    this.version = 0;
    this.timers = [];
  }

  start() {
    this.scan({ full: true });
    this.poll();
    let scans = 0;
    this.timers.push(setInterval(() => this.scan({ full: ++scans % 15 === 0 }), this.scanMs));
    this.timers.push(setInterval(() => this.poll(), this.pollMs));
    return this;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** One-shot load (no timers), for --json snapshots and tests. */
  loadOnce() {
    this.scan({ full: true });
    this.poll();
    return this;
  }

  // Date-directory pruning skips old dirs; a periodic full scan still finds old rollouts that were
  // resumed (appended to) recently.
  scan({ full = false } = {}) {
    const cutoff = Date.now() - this.sinceMs;
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 3 && (full || this.dirMayBeRecent(p, depth, cutoff))) walk(p, depth + 1);
        } else if (ROLLOUT_RE.test(e.name) && !this.files.has(p)) {
          try {
            if (fs.statSync(p).mtimeMs >= cutoff) this.files.set(p, { offset: 0, buf: '', threadId: null });
          } catch {}
        }
      }
    };
    walk(this.sessionsDir, 0);
  }

  // sessions/YYYY/MM/DD — skip whole year/month/day directories older than the window.
  dirMayBeRecent(p, depth, cutoff) {
    const parts = path.relative(this.sessionsDir, p).split(path.sep).map(Number);
    if (parts.some(Number.isNaN)) return true;
    const [y, m = 12, d] = parts;
    const end = d ? Date.UTC(y, m - 1, d + 1) : Date.UTC(y, m, 1);
    return end + 86400000 >= cutoff;
  }

  poll() {
    let changed = false;
    for (const [p, st] of this.files) {
      let size;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue;
      }
      if (size < st.offset) {
        st.offset = 0;
        st.buf = '';
      }
      if (size === st.offset) continue;
      const fd = fs.openSync(p, 'r');
      try {
        const len = size - st.offset;
        const chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, st.offset);
        st.offset = size;
        const text = st.buf + chunk.toString('utf8');
        const lines = text.split('\n');
        st.buf = lines.pop();
        for (const line of lines) if (line.trim() && this.ingestLine(p, st, line)) changed = true;
      } finally {
        fs.closeSync(fd);
      }
    }
    if (changed) {
      this.version++;
      this.emit('change', this.version);
    }
    return changed;
  }

  ingestLine(file, st, line) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return false;
    }
    const payload = rec.payload || {};
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();

    if (rec.type === 'session_meta') {
      if (st.threadId) return false; // only the first meta line describes this file's thread
      const t = this.threads.get(payload.id) || newThread(payload.id, file);
      const src = describeSource(payload.source);
      st.threadId = payload.id;
      t.file = file;
      t.sessionId = payload.session_id || payload.id;
      t.parentId = payload.parent_thread_id || src.parent_thread_id || null;
      t.nickname = payload.agent_nickname || src.agent_nickname || null;
      t.role = payload.agent_role || payload.agent_type || src.agent_role || null;
      t.depth = src.depth || (t.parentId ? 1 : 0);
      t.source = src;
      t.cwd = payload.cwd || null;
      t.provider = payload.model_provider || null;
      t.historyStart = payload.subagent_history_start_ordinal ?? null;
      t.startedAt = Date.parse(payload.timestamp || rec.timestamp) || ts;
      t.updatedAt = ts;
      if (payload.context_window?.model_context_window) t.contextWindow = payload.context_window.model_context_window;
      this.threads.set(payload.id, t);
      return true;
    }

    const t = st.threadId && this.threads.get(st.threadId);
    if (!t) return false;
    // Records inherited from a forked parent precede the sub-agent's own history.
    if (t.historyStart != null && rec.ordinal != null && rec.ordinal < t.historyStart) return false;

    if (rec.type === 'turn_context') {
      if (payload.model) t.model = payload.model;
      t.effort = payload.effort ?? payload.reasoning_effort ?? t.effort;
      t.updatedAt = ts;
      return true;
    }

    if (rec.type === 'token_usage_record') {
      if (payload.thread_id && payload.thread_id !== t.id) return false;
      t.hasUsageRecords = true;
      this.applyTotals(t, normalizeUsage(payload.thread_token_usage), normalizeUsage(payload.usage), ts);
      return true;
    }

    if (rec.type === 'event_msg') {
      switch (payload.type) {
        case 'token_count': {
          const info = payload.info;
          if (!info) return false;
          if (info.model_context_window) t.contextWindow = info.model_context_window;
          t.lastContextTokens = normalizeUsage(info.last_token_usage).total;
          if (!t.hasUsageRecords) this.applyTotals(t, normalizeUsage(info.total_token_usage), normalizeUsage(info.last_token_usage), ts);
          return true;
        }
        case 'task_started':
        case 'turn_started':
          t.status = 'running';
          t.updatedAt = ts;
          return true;
        case 'task_complete':
        case 'turn_complete':
          t.status = 'done';
          t.updatedAt = ts;
          return true;
        case 'turn_aborted':
          t.status = 'aborted';
          t.updatedAt = ts;
          return true;
        case 'error':
          t.status = 'error';
          t.updatedAt = ts;
          return true;
        default:
          return false;
      }
    }
    return false;
  }

  applyTotals(t, total, last, ts) {
    if (total.total < t.usage.total) return; // stale / replayed snapshot
    const delta = subUsage(total, t.usage);
    if (delta.total === 0 && total.total === t.usage.total) return;
    const model = t.model || 'unknown';
    t.byModel[model] = addUsage(t.byModel[model] || emptyUsage(), delta);
    t.usage = total;
    t.last = last;
    t.requests++;
    t.updatedAt = ts;
    t.history.push([ts, total.total]);
    if (t.history.length > HISTORY_LIMIT) t.history.shift();
  }

  /** Builds a JSON-friendly snapshot: sessions (root threads) with nested sub-agents. */
  snapshot({ limit = 20 } = {}) {
    const threads = [...this.threads.values()];
    const byId = new Map(threads.map((t) => [t.id, t]));
    const children = new Map();
    for (const t of threads) {
      const parent = t.parentId && byId.has(t.parentId) ? t.parentId : null;
      if (parent) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(t);
      }
    }
    const view = (t) => {
      const kids = (children.get(t.id) || []).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map(view);
      const subtree = kids.reduce((acc, k) => addUsage(acc, k.subtreeUsage), t.usage);
      const lastActive = Math.max(t.updatedAt || 0, ...kids.map((k) => k.lastActive));
      return {
        id: t.id,
        name: t.nickname || (t.parentId ? t.role || 'sub-agent' : 'main'),
        nickname: t.nickname,
        role: t.role,
        depth: t.depth,
        source: t.source.kind + (t.source.subKind ? `:${t.source.subKind}` : ''),
        model: t.model,
        effort: t.effort,
        provider: t.provider,
        status: t.status,
        cwd: t.cwd,
        contextWindow: t.contextWindow,
        contextUsed: t.lastContextTokens || 0,
        usage: t.usage,
        last: t.last,
        byModel: t.byModel,
        requests: t.requests,
        startedAt: t.startedAt,
        updatedAt: t.updatedAt,
        lastActive,
        history: t.history,
        subtreeUsage: subtree,
        children: kids,
      };
    };
    const allRoots = threads
      .filter((t) => !(t.parentId && byId.has(t.parentId)))
      .map(view)
      .sort((a, b) => b.lastActive - a.lastActive);

    const totals = { all: emptyUsage(), subagents: emptyUsage(), byModel: {} };
    const walk = (n, isSub) => {
      totals.all = addUsage(totals.all, n.usage);
      if (isSub) totals.subagents = addUsage(totals.subagents, n.usage);
      for (const [m, u] of Object.entries(n.byModel)) totals.byModel[m] = addUsage(totals.byModel[m] || emptyUsage(), u);
      n.children.forEach((c) => walk(c, true));
    };
    allRoots.forEach((r) => walk(r, r.source.startsWith('subagent')));
    return { version: this.version, generatedAt: Date.now(), codexHome: this.codexHome, sessions: allRoots.slice(0, limit), totals };
  }
}
