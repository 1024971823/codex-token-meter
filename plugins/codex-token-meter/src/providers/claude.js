// Claude Code (CLI, desktop app, IDE extensions) writes one JSONL transcript per
// session under <config>/projects/<project>/<sessionId>.jsonl; sub-agents (Task
// tool, /btw asides) get their own file in <project>/<sessionId>/subagents/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadStore, newThread, tailJsonl, walkFiles } from '../threads.js';

export function claudeRoots(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) {
    return env.CLAUDE_CONFIG_DIR.split(',').map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
  }
  const home = os.homedir();
  return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude'), path.join(home, '.claude')];
}

/** Claude usage excludes cache tokens from input_tokens; fold them in (input includes cached, like Codex). */
export function normalizeClaudeUsage(u = {}) {
  const fresh = u.input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  const output = u.output_tokens || 0;
  const input = fresh + read + write;
  return { input, cached: read, cacheWrite: write, output, reasoning: 0, total: input + output };
}

/** { sessionId, agentId|null, project } from a transcript path below <root>/projects. */
export function claudePathInfo(file) {
  const parts = file.replace(/\\/g, '/').split('/');
  const pi = parts.lastIndexOf('projects');
  const rel = parts.slice(pi + 1);
  const name = rel[rel.length - 1].replace(/\.jsonl$/, '');
  const si = rel.indexOf('subagents');
  if (si >= 2) return { sessionId: rel[si - 1], agentId: name, project: rel[0] };
  if (rel.length === 2) return { sessionId: name, agentId: null, project: rel[0] };
  return { sessionId: rel[rel.length - 2] || name, agentId: null, project: rel[0] };
}

export class ClaudeStore extends ThreadStore {
  constructor({ roots = claudeRoots(), sinceHours = 24, pollMs = 700, scanMs = 3000, pricingFile, pricing } = {}) {
    super({ sinceHours, pricingFile, pricing, providerId: 'claude' });
    this.roots_ = roots;
    this.pollMs = pollMs;
    this.scanMs = scanMs;
    this.files = new Map();
    this.seen = new Set(); // message.id:requestId — Claude writes one line per content block and replays parents in sidechains
  }

  start() {
    this.loadOnce();
    this.timers.push(setInterval(() => this.scan(), this.scanMs));
    this.timers.push(setInterval(() => this.poll(), this.pollMs));
    return this;
  }

  loadOnce() {
    this.scan();
    this.poll();
    return this;
  }

  projectDirs() {
    return this.roots_.map((r) => path.join(r, 'projects')).filter((d) => fs.existsSync(d));
  }

  scan() {
    const cutoff = Date.now() - this.sinceMs;
    const found = [];
    for (const dir of this.projectDirs()) found.push(...walkFiles(dir, /\.jsonl$/, { maxDepth: 6, minMtime: cutoff }));
    // Main transcripts first, so a parent message replayed in a sidechain is attributed to the parent.
    found.sort((a, b) => a.includes('/subagents/') - b.includes('/subagents/') || a.localeCompare(b));
    for (const p of found) {
      if (this.files.has(p)) continue;
      const info = claudePathInfo(p);
      this.files.set(p, { offset: 0, buf: '', info });
    }
  }

  threadFor(file, st, rec) {
    const { sessionId: pathSession, agentId } = st.info;
    const sessionId = (agentId ? pathSession : rec.sessionId) || pathSession;
    let id = sessionId;
    let parentId = null;
    if (agentId) {
      id = `${sessionId}/${agentId}`;
      parentId = sessionId;
    } else if (rec.isSidechain) {
      // Older Claude Code versions wrote Task sub-agent turns inline in the parent transcript.
      id = `${sessionId}/sidechain`;
      parentId = sessionId;
    }
    let t = this.threads.get(id);
    if (!t) {
      t = newThread(id, file);
      t.sessionId = sessionId;
      t.parentId = parentId;
      t.depth = parentId ? 1 : 0;
      t.source = parentId ? { kind: 'subagent', subKind: agentId ? 'task' : 'sidechain' } : { kind: 'cli' };
      if (parentId) {
        t.role = 'sub-agent';
        t.nickname = agentId ? this.agentName(file, agentId) : 'sidechain';
      }
      t.startedAt = Date.parse(rec.timestamp) || Date.now();
      this.threads.set(id, t);
      // A sub-agent seen before its parent still needs a parent node to hang from.
      if (parentId && !this.threads.has(parentId)) {
        const p = newThread(parentId, null);
        p.sessionId = parentId;
        p.source = { kind: 'cli' };
        p.startedAt = t.startedAt;
        this.threads.set(parentId, p);
      }
    }
    return t;
  }

  agentName(file, agentId) {
    try {
      const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      return meta.agentType || meta.subagent_type || meta.description || meta.name || agentId;
    } catch {
      return agentId.replace(/^agent-/, 'agent ');
    }
  }

  ingestLine(file, st, line) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return false;
    }
    if (!rec || typeof rec !== 'object' || (rec.type !== 'assistant' && rec.type !== 'user')) return false;
    const t = this.threadFor(file, st, rec);
    const ts = Date.parse(rec.timestamp) || Date.now();
    if (rec.cwd) t.cwd = rec.cwd;
    if (rec.version && !t.provider) t.provider = `claude-code ${rec.version}`;
    if (rec.type === 'user') {
      t.status = 'running';
      t.updatedAt = Math.max(t.updatedAt || 0, ts);
      if (t.parentId && this.threads.get(t.parentId)) this.threads.get(t.parentId).status = 'running';
      return true;
    }
    const msg = rec.message || {};
    if (msg.model && msg.model !== '<synthetic>') t.model = msg.model;
    t.status = msg.stop_reason === 'end_turn' ? 'done' : 'running';
    t.updatedAt = Math.max(t.updatedAt || 0, ts);
    if (!msg.usage) return true;
    const key = msg.id ? `${msg.id}:${rec.requestId || ''}${rec.requestId ? '' : `:${rec.sessionId}:${rec.timestamp}`}` : null;
    if (key) {
      if (this.seen.has(key)) return true;
      this.seen.add(key);
    }
    const usage = normalizeClaudeUsage(msg.usage);
    if (usage.total === 0) return true;
    t.lastContextTokens = usage.input;
    this.applyDelta(t, usage, ts, t.model);
    return true;
  }

  poll() {
    const changed = tailJsonl(this.files, (p, st, line) => this.ingestLine(p, st, line));
    if (changed) this.bump();
    return changed;
  }
}
