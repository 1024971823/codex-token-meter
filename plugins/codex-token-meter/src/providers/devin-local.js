// Devin for Terminal (CLI) and the Devin Desktop app's local agent keep session
// folders under the Devin data dir (~/.local/share/devin, %APPDATA%\devin, ...).
// The on-disk format is undocumented, so this reader is deliberately tolerant:
// each session folder's meta.json gives identity/model, and any JSON/JSONL record
// carrying token usage or `acu_cost` is summed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadStore, newThread, walkFiles } from '../threads.js';
import { openReadOnly } from '../sqlite.js';

export function devinDataRoots(env = process.env) {
  if (env.DEVIN_DATA_DIR) return env.DEVIN_DATA_DIR.split(',').map((d) => path.resolve(d.trim())).filter(Boolean);
  const home = os.homedir();
  const roots = [path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'devin')];
  if (process.platform === 'darwin') roots.push(path.join(home, 'Library', 'Application Support', 'devin'));
  if (process.platform === 'win32' && env.APPDATA) roots.push(path.join(env.APPDATA, 'devin'));
  return roots;
}

/** Devin Desktop (the Windsurf-based IDE) config dirs: <root>/User holds
 * globalStorage/state.vscdb (session index) and acp-messages/<uuid>.db
 * (per-session message stores). */
export function devinDesktopRoots(env = process.env) {
  if (env.DEVIN_DESKTOP_DIR) return env.DEVIN_DESKTOP_DIR.split(',').map((d) => path.resolve(d.trim())).filter(Boolean);
  const home = os.homedir();
  const roots = [];
  if (process.platform === 'darwin') roots.push(path.join(home, 'Library', 'Application Support', 'Devin', 'User'));
  else if (process.platform === 'win32' && env.APPDATA) roots.push(path.join(env.APPDATA, 'Devin', 'User'));
  else roots.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Devin', 'User'));
  return roots;
}

/** Normalizes the usage shapes seen in model APIs (Anthropic/OpenAI/Gemini). */
export function normalizeAnyUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const fresh = u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount ?? u.inputTokens;
  const output = u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? u.outputTokens;
  if (typeof fresh !== 'number' && typeof output !== 'number') return null;
  const read = u.cache_read_input_tokens ?? u.cache_read_tokens ?? u.cacheReadInputTokens ?? 0;
  const write = u.cache_creation_input_tokens ?? u.cache_write_tokens ?? u.cacheCreationInputTokens ?? 0;
  const cachedIncluded = u.prompt_tokens_details?.cached_tokens ?? u.cachedContentTokenCount;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? u.thoughtsTokenCount ?? 0;
  // OpenAI-style prompt_tokens already include cached tokens; Anthropic-style input_tokens do not.
  const input = cachedIncluded != null ? fresh || 0 : (fresh || 0) + read + write;
  const cached = cachedIncluded != null ? cachedIncluded : read;
  const out = (output || 0) + (u.thoughtsTokenCount && u.candidatesTokenCount != null ? reasoning : 0);
  return { input, cached, cacheWrite: write, output: out, reasoning, total: input + out };
}

function collect(value, sink, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return;
  if (Array.isArray(value)) return value.forEach((v) => collect(v, sink, depth + 1));
  if (typeof value.model === 'string' && !sink.model) sink.model = value.model;
  if (typeof value.acu_cost === 'number') sink.acus += value.acu_cost;
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'usage' || k === 'token_usage' || k === 'usage_metadata' || k === 'usageMetadata') && v && typeof v === 'object') {
      const u = normalizeAnyUsage(v);
      if (u && u.total) {
        sink.usages.push({ usage: u, model: typeof value.model === 'string' ? value.model : null, id: value.id || value.message_id || value.request_id || null });
        continue;
      }
    }
    if (v && typeof v === 'object') collect(v, sink, depth + 1);
  }
}

export class DevinLocalStore extends ThreadStore {
  constructor({ roots = devinDataRoots(), desktopRoots, sinceHours = 24, scanMs = 4000, pricingFile, pricing } = {}) {
    super({ sinceHours, pricingFile, pricing, providerId: 'devin-local' });
    this.roots_ = roots;
    this.desktopRoots = desktopRoots === undefined ? devinDesktopRoots() : desktopRoots;
    this.scanMs = scanMs;
    this.sigs = new Map();
    this.dbSigs = new Map();
    this.dbBusy = null;
  }

  start() {
    this.refresh();
    this.timers.push(setInterval(() => this.refresh(), this.scanMs));
    return this;
  }

  /** sessions.db files under the data roots — the Devin CLI / Desktop (Windsurf)
   * agent keeps its session index in SQLite, not meta.json folders. */
  sessionDbs() {
    const out = [];
    for (const root of this.roots_) {
      for (const f of walkFiles(root, /^sessions\.db$/, { maxDepth: 3 })) {
        if (!f.includes('/_versions/')) out.push(f);
      }
    }
    return out;
  }

  /**
   * Reads Devin Desktop/CLI sessions.db. Token usage is not stored per request;
   * message_nodes.metadata.num_tokens_preceding records each node's position in
   * the context window, so node sizes are deltas between consecutive positions
   * (negative after compaction → re-baseline). Assistant-node deltas count as
   * output, everything else as input. ACU comes from sessions.metadata.
   */
  async refreshSessionsDb(dbFile) {
    let st;
    try {
      st = fs.statSync(dbFile);
    } catch {
      return false;
    }
    const sig = `${st.size}:${st.mtimeMs}`;
    if (this.dbSigs.get(dbFile) === sig) return false;
    const db = await openReadOnly(dbFile);
    if (!db) return false; // don't cache sig: retry when a backend shows up
    try {
      if (!db.all("select name from sqlite_master where type='table' and name='sessions'").length) return false;
      const cutoff = Date.now() - this.sinceMs;
      const toMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);
      const sessions = db
        .all('select id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, hidden, metadata from sessions')
        .filter((s) => !s.hidden && (toMs(s.last_activity_at) || 0) >= cutoff);
      if (!sessions.length) return false;
      this.dbSigs.set(dbFile, sig); // cache only after the file parsed
      const nodes = db.all(
        "select row_id, session_id, metadata, instr(substr(chat_message,1,200),'\"role\":\"assistant\"') as asst, length(chat_message) as bytes from message_nodes order by row_id",
      );
      const bySess = new Map();
      for (const n of nodes) {
        if (!bySess.has(n.session_id)) bySess.set(n.session_id, []);
        bySess.get(n.session_id).push(n);
      }
      let changed = false;
      const live = new Set();
      for (const s of sessions) {
        const id = `db:${s.id}`;
        live.add(id);
        const acpId = `acp:${s.id}`;
        if (this.threads.has(acpId)) {
          this.threads.delete(acpId); // sessions.db supersedes the acp stub for the same slug
          changed = true;
        }
        const t = this.threads.get(id) || newThread(id, dbFile);
        t.sessionId = s.id;
        t.title = s.title || null;
        t.nickname = t.title;
        t.cwd = s.working_directory || null;
        t.model = s.model || null;
        t.depth = 0;
        const bt = String(s.backend_type || '').toLowerCase();
        t.source = { kind: bt === 'cli' || bt === 'terminal' ? 'cli' : 'desktop', subKind: bt || null };
        t.startedAt = toMs(s.created_at) || null;
        t.updatedAt = toMs(s.last_activity_at) || t.startedAt;
        try {
          const meta = JSON.parse(s.metadata || '{}');
          if (typeof meta.total_acu_cost === 'number') t.acus = meta.total_acu_cost;
        } catch {}
        // num_tokens_preceding marks a node's position in the context window.
        // Only positioned nodes carry it; the delta between consecutive positions
        // already covers any unpositioned nodes in between, so only positioned
        // rows are summed: first position = all earlier context, each positive
        // delta = tokens appended by the previous positioned node (its role
        // decides input vs output). A drop means compaction rewound the
        // position — re-baseline without counting.
        const usage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
        let maxCtx = 0;
        let requests = 0;
        let prev = null;
        let trailingBytes = 0;
        for (const n of bySess.get(s.id) || []) {
          let ctx = null;
          try {
            ctx = JSON.parse(n.metadata || '{}').num_tokens_preceding ?? null;
          } catch {}
          const asst = !!n.asst;
          if (asst) requests += 1;
          if (ctx == null) {
            trailingBytes += n.bytes || 0;
            continue;
          }
          maxCtx = Math.max(maxCtx, ctx);
          if (prev == null) {
            usage.input += ctx;
            usage.total += ctx;
          } else if (ctx > prev.ctx) {
            const size = ctx - prev.ctx;
            usage[prev.asst ? 'output' : 'input'] += size;
            usage.total += size;
          }
          prev = { ctx, asst };
          trailingBytes = 0;
        }
        // Unpositioned tail after the last positioned node: rough text estimate.
        if (trailingBytes) {
          const size = Math.ceil(trailingBytes / 4);
          usage.input += size;
          usage.total += size;
        }
        t.lastContextTokens = maxCtx;
        t.status = Date.now() - (t.updatedAt || 0) < 60000 ? 'running' : 'done';
        this.applyTotals(t, usage, { ...usage, input: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: usage.output }, t.updatedAt || Date.now());
        t.requests = requests; // applyTotals bumps requests itself; overwrite with the real assistant-node count
        this.threads.set(id, t);
        changed = true;
      }
      for (const id of [...this.threads.keys()]) {
        if (id.startsWith('db:') && !live.has(id)) {
          this.threads.delete(id);
          changed = true;
        }
      }
      return changed;
    } finally {
      db.close();
    }
  }

  /**
   * Devin Desktop (Windsurf IDE) conversations. The session index lives in
   * globalStorage/state.vscdb as keys
   * `windsurf.acp.messageStore.session.acp/<backend>/<slug>` -> {uuid,lastUpdated},
   * where uuid is the per-session message store `acp-messages/<uuid>.db`
   * (meta + messages tables). Those dbs carry no token fields, so acp-only
   * sessions show title/message stats with zero usage; slugs already covered
   * by sessions.db keep their richer token data.
   */
  async refreshAcpSessions() {
    const cutoff = Date.now() - this.sinceMs;
    let changed = false;
    const live = new Set();
    for (const root of this.desktopRoots) {
      const stateDb = await openReadOnly(path.join(root, 'globalStorage', 'state.vscdb'));
      if (!stateDb) continue;
      let index;
      const annotations = {};
      try {
        if (!stateDb.all("select name from sqlite_master where type='table' and name='ItemTable'").length) continue;
        index = stateDb.all("select key, value from ItemTable where key like 'windsurf.acp.messageStore.session.acp/%'");
        for (const r of stateDb.all("select value from ItemTable where key like 'devin.desktopShell.localSessionAnnotations.%'")) {
          try {
            for (const [k, v] of Object.entries(JSON.parse(r.value || '{}'))) annotations[k] = v || {};
          } catch {}
        }
      } finally {
        stateDb.close();
      }
      for (const row of index) {
        const m = /^windsurf\.acp\.messageStore\.session\.acp\/([^/]+)\/(.+)$/.exec(row.key || '');
        if (!m) continue;
        const [, backend, slugPath] = m;
        const slug = slugPath.split('/').pop() || slugPath; // cloud entries nest a cache path
        if (this.threads.has(`db:${slug}`)) continue; // sessions.db already covers it
        let info = {};
        try {
          info = JSON.parse(row.value || '{}');
        } catch {}
        const dbFile = path.join(root, 'acp-messages', `${info.uuid || slug}.db`);
        let st;
        try {
          st = fs.statSync(dbFile);
        } catch {
          st = null; // index entry without a message store
        }
        const ann = annotations[`devin-acp/${backend}/${slugPath}`] || {};
        if (ann.archived) continue;
        const id = `acp:${slug}`;
        const counts = {};
        let title = null;
        let meta = {};
        if (st && !ann.empty) {
          const db = await openReadOnly(dbFile);
          if (db) {
            try {
              try {
                for (const r of db.all('select kind, count(*) as c from messages group by kind')) counts[r.kind] = r.c;
              } catch {}
              try {
                meta = Object.fromEntries(db.all('select key, value from meta'));
              } catch {}
              try {
                const u = db.all("select payload from messages where kind='user_message' order by position limit 1")[0];
                if (u) {
                  const p = JSON.parse(u.payload);
                  const texts = (p.content || []).map((c) => c?.content?.text).filter(Boolean);
                  title = texts.join(' ').slice(0, 80) || null;
                }
              } catch {}
            } finally {
              db.close();
            }
          }
        }
        let lastMs = Number(info.lastUpdated) || 0;
        try {
          const skel = JSON.parse(meta.history_skeleton || '{}');
          for (const it of skel.items || []) if (it.created_at_ms > lastMs) lastMs = it.created_at_ms;
        } catch {}
        const updatedMs = Math.max(lastMs, st?.mtimeMs || 0) || 0;
        if (updatedMs < cutoff) continue;
        live.add(id);
        const sig = `${dbFile}:${st?.size || 0}:${st?.mtimeMs || 0}:${info.lastUpdated || 0}`;
        const t = this.threads.get(id) || newThread(id, dbFile);
        t.sessionId = slug;
        t.title = title || slug;
        t.nickname = t.title;
        t.cwd = null;
        t.depth = 0;
        t.source = { kind: 'desktop', subKind: backend };
        t.startedAt = null;
        t.updatedAt = updatedMs || null;
        t.requests = (counts.agent_message || 0) + (counts.tool_call || 0);
        t.status = Date.now() - (t.updatedAt || 0) < 60000 ? 'running' : 'done';
        this.threads.set(id, t);
        if (this.dbSigs.get(id) !== sig) {
          this.dbSigs.set(id, sig);
          changed = true;
        }
      }
    }
    for (const id of [...this.threads.keys()]) {
      if (id.startsWith('acp:') && !live.has(id)) {
        this.threads.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  refreshSessionsDbs() {
    if (!this.dbBusy) {
      this.dbBusy = (async () => {
        try {
          let changed = false;
          for (const f of this.sessionDbs()) changed = (await this.refreshSessionsDb(f)) || changed;
          changed = (await this.refreshAcpSessions()) || changed; // after sessions.db so db: slugs dedupe
          if (changed) this.bump();
        } catch {
          // unreadable/corrupt db: folder scan still runs; next tick retries
        } finally {
          this.dbBusy = null;
        }
      })();
    }
    return this.dbBusy;
  }

  loadOnce() {
    this.refresh();
    return this;
  }

  async loadOnceAsync() {
    this.loadOnce();
    await this.refreshSessionsDbs();
    return this;
  }

  sessionDirs() {
    const cutoff = Date.now() - this.sinceMs;
    const dirs = new Set();
    for (const root of this.roots_) {
      for (const meta of walkFiles(root, /^meta\.json$/, { maxDepth: 5 })) {
        if (meta.includes('/_versions/')) continue;
        const dir = path.dirname(meta);
        const newest = walkFiles(dir, /\.(jsonl?|ndjson)$/, { maxDepth: 2 }).reduce((m, f) => {
          try {
            return Math.max(m, fs.statSync(f).mtimeMs);
          } catch {
            return m;
          }
        }, 0);
        if (newest >= cutoff) dirs.add(dir);
      }
    }
    return [...dirs];
  }

  refresh() {
    this.refreshSessionsDbs(); // async; bumps on its own when threads change
    let changed = false;
    const live = new Set();
    for (const dir of this.sessionDirs()) {
      const files = walkFiles(dir, /\.(jsonl?|ndjson)$/, { maxDepth: 2 });
      const sig = files.map((f) => {
        try {
          const s = fs.statSync(f);
          return `${f}:${s.size}:${s.mtimeMs}`;
        } catch {
          return f;
        }
      }).join('|');
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      } catch {}
      const id = String(meta.session_id || meta.id || path.basename(dir));
      live.add(id);
      if (this.sigs.get(dir) === sig) continue;
      this.sigs.set(dir, sig);
      const t = newThread(id, dir);
      t.sessionId = id;
      t.title = meta.title || meta.name || null;
      t.nickname = t.title;
      t.cwd = meta.cwd || meta.working_directory || meta.workspace || null;
      t.model = meta.model || null;
      t.parentId = meta.parent_session_id || meta.parent_id || null;
      t.depth = t.parentId ? 1 : 0;
      t.source = { kind: t.parentId ? 'subagent' : 'cli' };
      const toMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);
      t.startedAt = toMs(meta.created_at || meta.createdAt) || null;
      const sink = { usages: [], acus: 0, model: null };
      const seen = new Set();
      let newest = 0;
      for (const f of files) {
        if (f.endsWith('/meta.json')) continue;
        let text = '';
        try {
          text = fs.readFileSync(f, 'utf8');
          newest = Math.max(newest, fs.statSync(f).mtimeMs);
        } catch {
          continue;
        }
        const lines = f.endsWith('.json') ? [text] : text.split('\n');
        for (const line of lines) {
          if (!line.includes('token') && !line.includes('acu_cost') && !line.includes('Token')) continue;
          try {
            collect(JSON.parse(line), sink);
          } catch {}
        }
      }
      t.model = t.model || sink.model;
      for (const u of sink.usages) {
        if (u.id && seen.has(u.id)) continue;
        if (u.id) seen.add(u.id);
        this.applyDelta(t, u.usage, newest, u.model || t.model);
      }
      t.acus = sink.acus || null;
      t.updatedAt = Math.max(t.updatedAt || 0, newest, toMs(meta.updated_at || meta.updatedAt) || 0);
      t.startedAt = t.startedAt || t.updatedAt;
      t.status = Date.now() - t.updatedAt < 60000 ? 'running' : 'done';
      this.threads.set(id, t);
      changed = true;
    }
    for (const id of [...this.threads.keys()]) {
      // db:/acp: threads are owned by refreshSessionsDbs, not the folder scan
      if (!live.has(id) && !id.startsWith('db:') && !id.startsWith('acp:')) {
        this.threads.delete(id);
        changed = true;
      }
    }
    if (changed) this.bump();
    return changed;
  }
}
