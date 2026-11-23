// Aggregates every provider (Codex, Claude Code, Antigravity, Devin local + cloud)
// into one live snapshot with per-provider connection status. Exposes the same
// interface as a single store (snapshot/start/stop/'change'), so the web
// dashboard, TUI and desktop app can use either.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { computeTotals } from './threads.js';
import { loadPricing, PRICING_CURRENCY } from './pricing.js';
import { RolloutStore, defaultCodexHome } from './store.js';
import { ClaudeStore, claudeRoots } from './providers/claude.js';
import { AntigravityStore, antigravityRoots } from './providers/antigravity.js';
import { DevinLocalStore, devinDataRoots } from './providers/devin-local.js';
import { DevinCloudStore } from './providers/devin-cloud.js';
import { detectTool, runningProcesses } from './detect.js';
import { sqliteBackend } from './sqlite.js';

export const PROVIDER_IDS = ['codex', 'claude', 'antigravity', 'devin-local', 'devin-cloud'];

export const PROVIDER_META = {
  codex: { name: 'Codex', tool: 'codex', surfaces: 'CLI · Desktop · IDE' },
  claude: { name: 'Claude Code', tool: 'claude', surfaces: 'CLI · Desktop · IDE' },
  antigravity: { name: 'Antigravity', tool: 'antigravity', surfaces: 'IDE · CLI' },
  'devin-local': { name: 'Devin (local)', tool: 'devin', surfaces: 'CLI · Desktop' },
  'devin-cloud': { name: 'Devin (cloud)', tool: null, surfaces: 'Web · Slack · Desktop · API' },
};

export function parseProviders(value) {
  if (!value || value === 'all') return [...PROVIDER_IDS];
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => (s === 'devin' ? ['devin-local', 'devin-cloud'] : [s]));
  const bad = ids.filter((id) => !PROVIDER_IDS.includes(id));
  if (bad.length) throw new Error(`unknown provider(s): ${bad.join(', ')} (known: ${PROVIDER_IDS.join(', ')}, devin, all)`);
  return [...new Set(ids)];
}

const existing = (dirs) => dirs.filter((d) => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
});

export class Hub extends EventEmitter {
  constructor({ providers = PROVIDER_IDS, codexHome = defaultCodexHome(), sinceHours = 24, pricingFile, devin = {}, roots = {}, fetchImpl } = {}) {
    super();
    this.pricing = loadPricing({ pricingFile });
    this.codexHome = codexHome;
    this.ids = providers;
    this.version = 0;
    this.detection = {};
    this.timers = [];
    const common = { sinceHours, pricing: this.pricing };
    const make = {
      codex: () => new RolloutStore({ ...common, codexHome }),
      claude: () => new ClaudeStore({ ...common, roots: roots.claude || claudeRoots() }),
      antigravity: () => new AntigravityStore({ ...common, roots: roots.antigravity || antigravityRoots() }),
      'devin-local': () => new DevinLocalStore({ ...common, roots: roots.devinLocal || devinDataRoots() }),
      'devin-cloud': () =>
        new DevinCloudStore({
          ...common,
          apiKey: devin.apiKey ?? process.env.DEVIN_API_KEY,
          orgId: devin.orgId ?? process.env.DEVIN_ORG_ID,
          baseUrl: devin.baseUrl || process.env.DEVIN_API_BASE || undefined,
          fetchImpl,
        }),
    };
    this.stores = Object.fromEntries(providers.map((id) => [id, make[id]()]));
    for (const [id, store] of Object.entries(this.stores)) {
      store.on('change', () => {
        this.bump();
        // Connection state of the API provider changes with each sync; reflect it right away.
        if (id === 'devin-cloud') this.detect();
      });
    }
  }

  bump() {
    this.version++;
    this.emit('change', this.version);
  }

  start() {
    for (const s of Object.values(this.stores)) s.start();
    this.detect();
    this.timers.push(setInterval(() => this.detect(), 10000));
    return this;
  }

  stop() {
    for (const s of Object.values(this.stores)) s.stop();
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** One-shot load of every provider (for json/summary output and tests). */
  async loadOnce() {
    for (const s of Object.values(this.stores)) {
      if (s.loadOnceAsync) await s.loadOnceAsync();
      else s.loadOnce();
    }
    await this.detect();
    return this;
  }

  configureDevin(cfg) {
    return this.stores['devin-cloud'] ? this.stores['devin-cloud'].configure(cfg) : Promise.resolve(false);
  }

  dataRoots(id) {
    const s = this.stores[id];
    if (id === 'codex') return existing([s.sessionsDir]);
    if (id === 'claude') return existing(s.projectDirs());
    return existing(s.roots_ || []);
  }

  /** Refreshes install/running/data status for every provider; emits 'change' when it differs. */
  async detect() {
    const processes = await runningProcesses();
    const sqlite = this.stores.antigravity ? await sqliteBackend() : null;
    const next = {};
    for (const id of this.ids) {
      const meta = PROVIDER_META[id];
      const store = this.stores[id];
      const tool = meta.tool ? await detectTool(meta.tool, { processes }) : { bins: [], apps: [] };
      const sessions = store.threads.size ? [...store.threads.values()].filter((t) => !t.parentId).length : 0;
      const roots = id === 'devin-cloud' ? [] : this.dataRoots(id);
      let state;
      let detail = null;
      if (id === 'devin-cloud') {
        if (!store.apiKey) state = 'needs-key';
        else if (store.state.error) [state, detail] = ['error', store.state.error];
        else if (store.state.ok) {
          state = sessions ? 'active' : 'connected';
          detail = [store.state.principal, store.state.truncated && `only the newest ${store.state.truncated} sessions are counted`].filter(Boolean).join(' · ') || null;
        }
        else state = 'connecting';
      } else if (id === 'antigravity' && roots.length && !sqlite) {
        [state, detail] = ['error', 'SQLite unavailable: needs Node >= 22.13 or the sql.js package'];
      } else if (sessions) state = 'active';
      else if (roots.length) state = 'connected';
      else if (tool.bins.length || tool.apps.length) state = 'installed';
      else state = 'not-found';
      next[id] = { id, name: meta.name, surfaces: meta.surfaces, state, detail, sessions, roots, bins: tool.bins, running: tool.apps };
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.detection);
    this.detection = next;
    if (changed) this.bump();
    return next;
  }

  roots() {
    return Object.values(this.stores).flatMap((s) => s.roots()).sort((a, b) => b.lastActive - a.lastActive);
  }

  snapshot({ limit = 20 } = {}) {
    const all = this.roots();
    const byProvider = {};
    for (const id of this.ids) {
      const mine = all.filter((r) => r.provider === id);
      byProvider[id] = computeTotals(mine, this.pricing);
    }
    return {
      version: this.version,
      generatedAt: Date.now(),
      codexHome: this.codexHome,
      pricing: { date: this.pricing.date, source: this.pricing.source, currency: PRICING_CURRENCY },
      providers: this.ids.map((id) => this.detection[id] || { id, name: PROVIDER_META[id].name, surfaces: PROVIDER_META[id].surfaces, state: 'detecting', sessions: 0, roots: [], bins: [], running: [] }),
      // Up to `limit` sessions per provider, so a busy source cannot crowd out the others.
      sessions: this.ids.flatMap((id) => all.filter((r) => r.provider === id).slice(0, limit)).sort((a, b) => b.lastActive - a.lastActive),
      totals: computeTotals(all, this.pricing),
      byProvider,
    };
  }
}
