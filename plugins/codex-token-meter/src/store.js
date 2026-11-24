// Tails Codex rollout files (~/.codex/sessions/**/rollout-*.jsonl) and keeps a live
// per-thread view of model + token usage, grouped into parent -> sub-agent trees.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadStore, newThread, tailJsonl, emptyUsage, addUsage } from './threads.js';

export { emptyUsage, addUsage };

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;

export function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

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
  if (source.custom) return { kind: typeof source.custom === 'string' ? source.custom : 'custom' };
  if (source.internal) return { kind: 'internal', subKind: String(source.internal) };
  return { kind: Object.keys(source)[0] || 'unknown' };
}

export class RolloutStore extends ThreadStore {
  constructor({ codexHome = defaultCodexHome(), sinceHours = 24, pollMs = 500, scanMs = 2000, pricingFile, pricing } = {}) {
    super({ sinceHours, pricingFile, pricing, providerId: 'codex' });
    this.codexHome = codexHome;
    this.sessionsDir = path.join(codexHome, 'sessions');
    this.pollMs = pollMs;
    this.scanMs = scanMs;
    this.files = new Map(); // path -> { offset, buf, threadId, size }
  }

  start() {
    this.scan({ full: true });
    this.poll();
    let scans = 0;
    this.timers.push(setInterval(() => this.scan({ full: ++scans % 15 === 0 }), this.scanMs));
    this.timers.push(setInterval(() => this.poll(), this.pollMs));
    return this;
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
    // Drop files (and their threads) idle beyond the window, so a long-lived daemon's
    // memory and per-poll stat calls stay bounded. A file that later resumes is
    // re-discovered by its fresh mtime and re-read from offset 0.
    const stale = new Set();
    for (const [p] of this.files) {
      let mtime = 0;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {}
      if (mtime < cutoff) {
        this.files.delete(p);
        stale.add(p);
      }
    }
    for (const [id, t] of this.threads) if (t.file && stale.has(t.file)) this.threads.delete(id);
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
    const changed = tailJsonl(this.files, (p, st, line) => this.ingestLine(p, st, line));
    if (changed) this.bump();
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
      t.originator = payload.originator || null;
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

    if (rec.type === 'compacted') {
      t.compacted = true;
      t.updatedAt = ts;
      return true;
    }

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

  snapshot(opts) {
    return { ...super.snapshot(opts), codexHome: this.codexHome };
  }
}
