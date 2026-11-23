// Provider-neutral agent/thread model shared by every source (Codex, Claude Code,
// Antigravity, Devin). A provider store fills `this.threads` and calls
// applyTotals/applyDelta; this base turns them into session trees with costs.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { estimateCost, estimateCostByModel, loadPricing, PRICING_CURRENCY } from './pricing.js';

const USAGE_KEYS = ['input', 'cached', 'cacheWrite', 'output', 'reasoning', 'total'];
const HISTORY_LIMIT = 120;

export const emptyUsage = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
export const addUsage = (a, b) => Object.fromEntries(USAGE_KEYS.map((k) => [k, (a[k] || 0) + (b[k] || 0)]));
export const subUsage = (a, b) => Object.fromEntries(USAGE_KEYS.map((k) => [k, Math.max(0, (a[k] || 0) - (b[k] || 0))]));

export function newThread(id, file) {
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
    acus: null,
    url: null,
    title: null,
  };
}

/**
 * Incrementally reads appended lines from a set of JSONL files.
 * `files` maps path -> { offset, buf, ... }; returns true when onLine reported a change.
 */
export function tailJsonl(files, onLine) {
  let changed = false;
  for (const [p, st] of files) {
    let size;
    try {
      size = fs.statSync(p).size;
    } catch {
      continue;
    }
    if (size < st.offset) {
      st.offset = 0;
      st.buf = '';
      if (st.onReset) st.onReset();
    }
    if (size === st.offset) continue;
    let fd;
    try {
      fd = fs.openSync(p, 'r');
    } catch {
      continue;
    }
    try {
      const len = size - st.offset;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, st.offset);
      st.offset = size;
      const lines = (st.buf + chunk.toString('utf8')).split('\n');
      st.buf = lines.pop();
      for (const line of lines) if (line.trim() && onLine(p, st, line)) changed = true;
    } finally {
      fs.closeSync(fd);
    }
  }
  return changed;
}

/** Recursively lists files under `dir` whose name matches `re` (bounded depth, missing dirs ignored). */
export function walkFiles(dir, re, { maxDepth = 6, minMtime = 0, onFile } = {}) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`.replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
      } else if (re.test(e.name)) {
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          continue;
        }
        if (mtime >= minMtime) {
          out.push(p);
          if (onFile) onFile(p, mtime);
        }
      }
    }
  };
  walk(dir.replace(/\\/g, '/'), 0);
  return out;
}

/** Usage/cost totals for a list of session roots (all threads, sub-agents only, per model). */
export function computeTotals(roots, pricing) {
  const totals = { all: emptyUsage(), subagents: emptyUsage(), byModel: {}, acus: null };
  const isSub = (n) => n.depth > 0 || n.source.startsWith('subagent');
  const subByModel = {};
  const walk = (n) => {
    totals.all = addUsage(totals.all, n.usage);
    if (n.acus != null) totals.acus = (totals.acus || 0) + n.acus;
    for (const [m, u] of Object.entries(n.byModel)) totals.byModel[m] = addUsage(totals.byModel[m] || emptyUsage(), u);
    if (isSub(n)) {
      totals.subagents = addUsage(totals.subagents, n.usage);
      for (const [m, u] of Object.entries(n.byModel)) subByModel[m] = addUsage(subByModel[m] || emptyUsage(), u);
    }
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  // Cost totals are priced from the aggregated per-model usage, so a model
  // used by several threads is priced once, on its combined usage.
  const price = (byModel, keep) => {
    let priced = true;
    let anyPriced = false;
    let cost = 0;
    for (const [m, u] of Object.entries(byModel)) {
      const est = estimateCost(u, m, pricing.table);
      if (keep) byModel[m] = { ...u, cost: est ? est.cost : null, priced: !!est };
      if (u.total > 0) {
        if (est) {
          anyPriced = true;
          cost += est.cost;
        } else priced = false;
      }
    }
    return { cost: anyPriced ? cost : null, priced };
  };
  const all = price(totals.byModel, true);
  const sub = price(subByModel, false);
  totals.all = { ...totals.all, cost: all.cost, priced: all.priced };
  totals.subagents = { ...totals.subagents, cost: sub.cost, priced: sub.priced };
  totals.cost = all.cost;
  totals.costPriced = all.priced;
  totals.currency = PRICING_CURRENCY;
  return totals;
}

export class ThreadStore extends EventEmitter {
  constructor({ sinceHours = 24, pricingFile, pricing, providerId = 'unknown' } = {}) {
    super();
    // Pricing override: --pricing-file (or CODEX_TOKEN_METER_PRICING env) wins over the built-in table.
    this.pricing = pricing || loadPricing({ pricingFile });
    this.providerId = providerId;
    this.sinceMs = sinceHours * 3600 * 1000;
    this.threads = new Map();
    this.version = 0;
    this.timers = [];
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  bump() {
    this.version++;
    this.emit('change', this.version);
  }

  /** Records a cumulative usage total (Codex-style counters). */
  applyTotals(t, total, last, ts) {
    // A lower cumulative total means the counter was reset (e.g. a new accounting
    // epoch after compaction); accept it as a fresh baseline instead of freezing.
    const reset = total.total < t.usage.total;
    const delta = reset ? total : subUsage(total, t.usage);
    if (delta.total === 0 && total.total === t.usage.total) return;
    const model = t.model || 'unknown';
    t.byModel[model] = addUsage(t.byModel[model] || emptyUsage(), delta);
    t.usage = total;
    t.last = last;
    this.recordRequest(t, ts);
  }

  /** Records one request's usage (Claude/Antigravity-style per-response records). */
  applyDelta(t, delta, ts, model = t.model) {
    const m = model || 'unknown';
    t.byModel[m] = addUsage(t.byModel[m] || emptyUsage(), delta);
    t.usage = addUsage(t.usage, delta);
    t.last = delta;
    this.recordRequest(t, ts);
  }

  recordRequest(t, ts) {
    t.requests++;
    t.updatedAt = Math.max(t.updatedAt || 0, ts || 0) || ts;
    t.history.push([ts, t.usage.total]);
    if (t.history.length > HISTORY_LIMIT) t.history.shift();
  }

  /** Session trees (root threads with nested sub-agents), most recently active first. */
  roots() {
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
      // Cost is priced from the per-model deltas (a thread may switch models),
      // not from the last model seen. `cost` is null when nothing in this
      // thread is priced, and `costPriced` is false when only part of it is.
      const byModel = Object.fromEntries(
        Object.entries(t.byModel).map(([m, u]) => {
          const est = estimateCost(u, m, this.pricing.table);
          return [m, { ...u, cost: est ? est.cost : null, priced: !!est }];
        }),
      );
      const own = estimateCostByModel(t.byModel, this.pricing.table);
      const cost = !own.any ? 0 : own.pricedCount ? own.cost : null;
      const anyPricedInSubtree = cost !== null || kids.some((k) => k.subtreeCost !== null);
      const subtreeCost = anyPricedInSubtree ? kids.reduce((acc, k) => acc + (k.subtreeCost || 0), cost || 0) : null;
      const subtreeCostPriced = own.priced && kids.every((k) => k.subtreeCostPriced);
      const subtreeAcus = t.acus == null && kids.every((k) => k.subtreeAcus == null) ? null : kids.reduce((a, k) => a + (k.subtreeAcus || 0), t.acus || 0);
      const lastActive = Math.max(t.updatedAt || 0, ...kids.map((k) => k.lastActive));
      return {
        id: t.id,
        provider: this.providerId,
        name: t.nickname || (t.parentId ? t.role || 'sub-agent' : 'main'),
        nickname: t.nickname,
        title: t.title,
        role: t.role,
        depth: t.depth,
        source: t.source.kind + (t.source.subKind ? `:${t.source.subKind}` : ''),
        model: t.model,
        effort: t.effort,
        modelProvider: t.provider,
        status: t.status,
        cwd: t.cwd,
        url: t.url,
        contextWindow: t.contextWindow,
        contextUsed: t.lastContextTokens || 0,
        compacted: !!t.compacted,
        usage: t.usage,
        last: t.last,
        byModel,
        cost,
        costPriced: own.priced,
        acus: t.acus,
        requests: t.requests,
        startedAt: t.startedAt,
        updatedAt: t.updatedAt,
        lastActive,
        history: t.history,
        subtreeUsage: subtree,
        subtreeCost,
        subtreeCostPriced,
        subtreeAcus,
        children: kids,
      };
    };
    return threads
      .filter((t) => !(t.parentId && byId.has(t.parentId)))
      .map(view)
      .sort((a, b) => b.lastActive - a.lastActive);
  }

  /** Builds a JSON-friendly snapshot: sessions (root threads) with nested sub-agents. */
  snapshot({ limit = 20 } = {}) {
    const allRoots = this.roots();
    return {
      version: this.version,
      generatedAt: Date.now(),
      pricing: { date: this.pricing.date, source: this.pricing.source, currency: PRICING_CURRENCY },
      sessions: allRoots.slice(0, limit),
      totals: computeTotals(allRoots, this.pricing),
    };
  }
}
