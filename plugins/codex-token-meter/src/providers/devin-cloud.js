// Devin cloud sessions (web app, Slack, Devin Desktop, CLI cloud handoffs) via the
// Devin API v3. Devin bills in ACUs, not tokens, so these nodes carry `acus`.
import { ThreadStore, newThread } from '../threads.js';

export const DEVIN_API_BASE = 'https://api.devin.ai';

const STATUS = { new: 'running', claimed: 'running', resuming: 'running', running: 'running', exit: 'done', error: 'error', suspended: 'idle' };

function mapStatus(s) {
  if (s.status === 'running' && (s.status_detail === 'waiting_for_user' || s.status_detail === 'waiting_for_approval')) return 'waiting';
  if (s.status === 'running' && s.status_detail === 'finished') return 'done';
  return STATUS[s.status] || 'idle';
}

export class DevinCloudStore extends ThreadStore {
  constructor({ apiKey, orgId, baseUrl = DEVIN_API_BASE, sinceHours = 24, pollMs = 30000, maxPages = 20, fetchImpl = globalThis.fetch, pricingFile, pricing } = {}) {
    super({ sinceHours, pricingFile, pricing, providerId: 'devin-cloud' });
    this.apiKey = apiKey || null;
    this.orgId = orgId || null;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.pollMs = pollMs;
    this.maxPages = maxPages;
    this.fetch = fetchImpl;
    this.state = { ok: false, error: null, lastSync: null, principal: null };
    this.busy = null;
  }

  configure({ apiKey, orgId, baseUrl } = {}) {
    this.apiKey = apiKey || null;
    this.orgId = orgId || null;
    if (baseUrl) this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.state = { ok: false, error: null, lastSync: null, principal: null };
    this.threads.clear();
    this.bump();
    return this.refresh();
  }

  start() {
    this.refresh();
    this.timers.push(setInterval(() => this.refresh(), this.pollMs));
    return this;
  }

  async loadOnceAsync() {
    await this.refresh();
    return this;
  }

  async get(pathname) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Devin API URL must use https://');
    const res = await this.fetch(`${this.baseUrl}${pathname}`, { headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' } });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.detail || body.title || '';
      } catch {}
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  refresh() {
    if (!this.apiKey) return Promise.resolve(false);
    if (this.busy) return this.busy;
    this.busy = this.sync()
      .catch((e) => {
        const changed = this.state.error !== e.message;
        this.state = { ...this.state, ok: false, error: e.message };
        if (changed) this.bump();
        return false;
      })
      .finally(() => (this.busy = null));
    return this.busy;
  }

  async sync() {
    if (!this.orgId) {
      const self = await this.get('/v3/self');
      this.state.principal = self.service_user_name || self.user_email || self.principal_type || null;
      this.orgId = self.org_id;
      if (!this.orgId) throw new Error('API key is not bound to an organization; set the organization ID');
    }
    const cutoff = (Date.now() - this.sinceMs) / 1000;
    const items = [];
    let after = null;
    let truncated = false;
    for (let page = 0; page < this.maxPages; page++) {
      const q = new URLSearchParams({ first: '100' });
      if (after) q.set('after', after);
      const data = await this.get(`/v3/organizations/${encodeURIComponent(this.orgId)}/sessions?${q}`);
      const batch = data.items || [];
      items.push(...batch);
      if (!data.has_next_page || !data.end_cursor || batch.every((s) => (s.updated_at || 0) < cutoff)) break;
      after = data.end_cursor;
      if (page === this.maxPages - 1) truncated = true;
    }
    const recent = items.filter((s) => (s.updated_at || 0) >= cutoff);
    const before = JSON.stringify([...this.threads.values()].map((t) => [t.id, t.acus, t.status, t.updatedAt, t.title]));
    this.threads.clear();
    for (const s of recent) {
      const t = newThread(s.session_id, null);
      t.sessionId = s.session_id;
      t.parentId = s.parent_session_id || null;
      t.depth = t.parentId ? 1 : 0;
      t.title = s.title || null;
      t.nickname = s.title || null;
      t.role = t.parentId ? 'child session' : null;
      t.source = { kind: t.parentId ? 'subagent' : s.origin || 'cloud', subKind: t.parentId ? 'child_session' : undefined };
      t.model = s.devin_mode ? `devin-${s.devin_mode}` : 'devin';
      t.provider = 'devin';
      t.acus = typeof s.acus_consumed === 'number' ? s.acus_consumed : null;
      t.status = mapStatus(s);
      t.url = s.url || null;
      t.startedAt = (s.created_at || 0) * 1000;
      t.updatedAt = (s.updated_at || s.created_at || 0) * 1000;
      this.threads.set(t.id, t);
    }
    const after_ = JSON.stringify([...this.threads.values()].map((t) => [t.id, t.acus, t.status, t.updatedAt, t.title]));
    const wasOk = this.state.ok;
    this.state = { ...this.state, ok: true, error: null, lastSync: Date.now(), truncated: truncated ? items.length : null };
    if (before !== after_ || !wasOk) this.bump();
    return true;
  }
}
