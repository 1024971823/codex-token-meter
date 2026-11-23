import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ClaudeStore, claudePathInfo } from '../plugins/codex-token-meter/src/providers/claude.js';
import { AntigravityStore, normalizeAntigravityModel } from '../plugins/codex-token-meter/src/providers/antigravity.js';
import { DevinLocalStore, normalizeAnyUsage } from '../plugins/codex-token-meter/src/providers/devin-local.js';
import { DevinCloudStore } from '../plugins/codex-token-meter/src/providers/devin-cloud.js';
import { Hub, parseProviders } from '../plugins/codex-token-meter/src/hub.js';
import { startWeb, redactAccountData } from '../plugins/codex-token-meter/src/web.js';
import { getModelPricing } from '../plugins/codex-token-meter/src/pricing.js';
import { encode } from '../plugins/codex-token-meter/src/proto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(HERE, 'fixtures', 'claude');
const SID = 'c1a2b3c4-0000-4000-8000-000000000001';
const require = createRequire(import.meta.url);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atm-'));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('claude: paths map to session / sub-agent', () => {
  assert.deepEqual(claudePathInfo(`/x/projects/p/${SID}.jsonl`), { sessionId: SID, agentId: null, project: 'p' });
  assert.deepEqual(claudePathInfo(`/x/projects/p/${SID}/subagents/agent-a1.jsonl`), { sessionId: SID, agentId: 'agent-a1', project: 'p' });
});

test('claude: per-response usage, cache buckets, sub-agent tree, dedupe of repeated and replayed messages', () => {
  const store = new ClaudeStore({ roots: [CLAUDE], sinceHours: 1e7 }).loadOnce();
  const snap = store.snapshot();
  assert.equal(snap.sessions.length, 1);
  const s = snap.sessions[0];
  assert.equal(s.provider, 'claude');
  assert.equal(s.id, SID);
  assert.equal(s.cwd, '/home/u/proj');
  assert.equal(s.model, 'claude-sonnet-4-5-20250929');
  assert.equal(s.status, 'done');
  assert.equal(s.requests, 2);
  assert.deepEqual(s.usage, { input: 2610, cached: 2300, cacheWrite: 200, output: 130, reasoning: 0, total: 2740 });
  close(s.cost, (110 * 3 + 2300 * 0.3 + 200 * 3.75 + 130 * 15) / 1e6);
  assert.equal(s.children.length, 1);
  const sub = s.children[0];
  assert.equal(sub.name, 'code-reviewer');
  assert.equal(sub.model, 'claude-haiku-4-5-20251001');
  assert.equal(sub.requests, 1);
  assert.equal(sub.usage.total, 540);
  assert.equal(snap.totals.subagents.total, 540);
  assert.equal(snap.totals.all.total, 3280);
});

test('claude: appended lines update live', () => {
  const dir = tmp();
  const proj = path.join(dir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's1.jsonl');
  const line = (id, out) => JSON.stringify({ type: 'assistant', sessionId: 's1', requestId: `r-${id}`, timestamp: new Date().toISOString(), message: { id, model: 'claude-opus-4-5', usage: { input_tokens: 1, output_tokens: out } } }) + '\n';
  fs.writeFileSync(file, line('m1', 10));
  const store = new ClaudeStore({ roots: [dir] }).loadOnce();
  assert.equal(store.snapshot().sessions[0].usage.output, 10);
  fs.appendFileSync(file, line('m2', 5));
  assert.equal(store.poll(), true);
  assert.equal(store.snapshot().sessions[0].usage.output, 15);
});

async function writeAntigravityDb(file) {
  const SQL = await require('sql.js')();
  const db = new SQL.Database();
  db.run('CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE trajectory_metadata_blob (data BLOB);');
  const usage1 = [[1, 333], [2, 1000], [3, 200], [5, 5000], [9, 50], [10, 150], [11, 'resp-1']];
  db.run('INSERT INTO trajectory_metadata_blob VALUES (?)', [encode([[2, [[1, 1795399990]]]])]);
  db.run('INSERT INTO steps VALUES (0, ?)', [encode([[9, usage1], [24, [[12, 'Claude Sonnet 4.5 (Thinking)']]], [8, [[1, 1795400000]]]])]);
  // gen row mirroring step 0 (same response id) must not double count
  db.run('INSERT INTO gen_metadata VALUES (0, ?)', [encode([[1, [[4, usage1], [19, 'Claude Sonnet 4.5']]], [2, 0]])]);
  db.run('INSERT INTO gen_metadata VALUES (1, ?)', [encode([[1, [[4, [[2, 300], [3, 40], [11, 'resp-2']]], [19, 'Gemini 3 Pro (High)'], [9, [[4, [[1, 1795400100]]]]]]]])]);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

test('antigravity: model names normalize and price', () => {
  assert.equal(normalizeAntigravityModel('Gemini 3 Pro (High)'), 'gemini-3-pro-high');
  assert.equal(normalizeAntigravityModel(null, 334), 'claude-sonnet-4-5');
  assert.ok(getModelPricing('gemini-3-pro-high'));
  assert.ok(getModelPricing('claude-sonnet-4.5'));
  assert.ok(getModelPricing('claude-sonnet-4-5-20250929'));
});

test('antigravity: reads SQLite conversations with protobuf usage and dedupes mirrored generations', async () => {
  const dir = tmp();
  const conv = path.join(dir, 'antigravity-ide', 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  await writeAntigravityDb(path.join(conv, 'conv-1.db'));
  const store = await new AntigravityStore({ roots: [conv], sinceHours: 1e7 }).loadOnceAsync();
  const [s] = store.snapshot().sessions;
  assert.equal(s.provider, 'antigravity');
  assert.equal(s.id, 'conv-1');
  assert.equal(s.source, 'antigravity-ide');
  assert.equal(s.requests, 2);
  assert.equal(s.model, 'gemini-3-pro-high');
  assert.deepEqual(Object.keys(s.byModel).sort(), ['claude-sonnet-4.5', 'gemini-3-pro-high']);
  assert.deepEqual(s.byModel['claude-sonnet-4.5'].input, 6000);
  assert.equal(s.byModel['claude-sonnet-4.5'].cached, 5000);
  assert.equal(s.byModel['claude-sonnet-4.5'].output, 200);
  assert.equal(s.byModel['claude-sonnet-4.5'].reasoning, 50);
  assert.equal(s.usage.total, 6200 + 340);
  assert.equal(s.costPriced, true);
  assert.equal(s.startedAt, 1795399990000);
});

test('devin local: tolerant session-folder reader sums usage and ACUs once', () => {
  const dir = tmp();
  const s1 = path.join(dir, 'cli', 'sessions', 's1');
  fs.mkdirSync(s1, { recursive: true });
  fs.writeFileSync(path.join(s1, 'meta.json'), JSON.stringify({ id: 's1', title: 'fix bug', cwd: '/w', model: 'claude-sonnet-4-5' }));
  const rec = { type: 'model_response', id: 'r1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } };
  fs.writeFileSync(path.join(s1, 'events.jsonl'), [rec, rec, { acu_cost: 0.25 }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const [s] = new DevinLocalStore({ roots: [dir] }).loadOnce().snapshot().sessions;
  assert.equal(s.provider, 'devin-local');
  assert.equal(s.title, 'fix bug');
  assert.equal(s.usage.total, 115);
  assert.equal(s.usage.cached, 100);
  assert.equal(s.acus, 0.25);
  assert.deepEqual(normalizeAnyUsage({ prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } }), { input: 50, cached: 20, cacheWrite: 0, output: 7, reasoning: 0, total: 57 });
});

function fakeDevinApi(calls = []) {
  const now = Math.floor(Date.now() / 1000);
  return async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/v3/self')) return json({ principal_type: 'service_user', service_user_name: 'meter', org_id: 'org-1' });
    if (url.includes('/v3/organizations/org-1/sessions')) {
      return json({
        items: [
          { session_id: 'p1', status: 'running', status_detail: 'working', acus_consumed: 3.5, created_at: now - 600, updated_at: now - 5, title: 'Parent', devin_mode: 'normal', origin: 'desktop', url: 'https://app.devin.ai/sessions/p1', parent_session_id: null },
          { session_id: 'c1', status: 'running', status_detail: 'waiting_for_user', acus_consumed: 1.25, created_at: now - 300, updated_at: now - 60, title: 'Child', devin_mode: 'fast', origin: 'api', parent_session_id: 'p1' },
          { session_id: 'old', status: 'exit', acus_consumed: 9, created_at: now - 9e6, updated_at: now - 9e6, parent_session_id: null },
        ],
        has_next_page: false,
        end_cursor: null,
      });
    }
    return json({ detail: 'nope' }, 404);
  };
}

test('devin cloud: sessions with ACUs, child sessions nest under parents', async () => {
  const calls = [];
  const store = await new DevinCloudStore({ apiKey: 'cog_test', fetchImpl: fakeDevinApi(calls) }).loadOnceAsync();
  assert.equal(calls[0].auth, 'Bearer cog_test');
  const snap = store.snapshot();
  assert.equal(snap.sessions.length, 1);
  const [p] = snap.sessions;
  assert.equal(p.title, 'Parent');
  assert.equal(p.model, 'devin-normal');
  assert.equal(p.url, 'https://app.devin.ai/sessions/p1');
  assert.equal(p.status, 'running');
  assert.equal(p.children[0].status, 'waiting');
  assert.equal(p.subtreeAcus, 4.75);
  assert.equal(snap.totals.acus, 4.75);
});

test('devin cloud: API errors are reported, not thrown', async () => {
  const store = new DevinCloudStore({ apiKey: 'bad', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'Invalid API key' }) }) });
  await store.loadOnceAsync();
  assert.equal(store.state.ok, false);
  assert.match(store.state.error, /401.*Invalid API key/);
});

test('hub: detects every provider, merges sessions and serves them over the dashboard API', async () => {
  const ag = tmp();
  await writeAntigravityDb(path.join(ag, 'conv-1.db'));
  const empty = tmp();
  const hub = new Hub({
    codexHome: path.join(HERE, 'fixtures'),
    sinceHours: 1e7,
    roots: { claude: [CLAUDE], antigravity: [ag], devinLocal: [path.join(empty, 'missing')] },
    devin: { apiKey: 'cog_test' },
    fetchImpl: fakeDevinApi(),
  });
  await hub.loadOnce();
  const snap = hub.snapshot({ limit: 50 });
  const state = Object.fromEntries(snap.providers.map((p) => [p.id, p.state]));
  assert.equal(state.codex, 'active');
  assert.equal(state.claude, 'active');
  assert.equal(state.antigravity, 'active');
  assert.ok(['not-found', 'installed'].includes(state['devin-local']));
  assert.equal(state['devin-cloud'], 'active');
  assert.deepEqual([...new Set(snap.sessions.map((s) => s.provider))].sort(), ['antigravity', 'claude', 'codex', 'devin-cloud']);
  assert.equal(snap.byProvider.claude.all.total, 3280);
  assert.equal(snap.totals.acus, 13.75); // sinceHours 1e7 also keeps the 104-day-old session
  assert.equal(snap.totals.all.total, Object.values(snap.byProvider).reduce((a, t) => a + t.all.total, 0));

  const server = await startWeb(hub, { port: 0 });
  const { port } = server.address();
  const body = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(body.providers.length, 5);
  assert.ok(body.sessions.some((s) => s.provider === 'claude'));
  server.close();
  hub.stop();
});

test('hub: provider list parsing', () => {
  assert.deepEqual(parseProviders('codex,devin'), ['codex', 'devin-local', 'devin-cloud']);
  assert.equal(parseProviders('all').length, 5);
  assert.throws(() => parseProviders('cursor'), /unknown provider/);
});

test('devin cloud: never sends the key over plain HTTP to a remote host', async () => {
  let called = false;
  const store = new DevinCloudStore({ apiKey: 'cog_x', baseUrl: 'http://devin.example.com', fetchImpl: async () => ((called = true), { ok: true, json: async () => ({}) }) });
  await store.loadOnceAsync();
  assert.equal(called, false);
  assert.match(store.state.error, /https/);
});

test('web: cross-origin state omits Devin cloud sessions', async () => {
  const hub = new Hub({ providers: ['codex', 'devin-cloud'], codexHome: path.join(HERE, 'fixtures'), sinceHours: 1e7, devin: { apiKey: 'cog_test' }, fetchImpl: fakeDevinApi() });
  await hub.loadOnce();
  assert.equal(redactAccountData(hub.snapshot()).sessions.some((s) => s.provider === 'devin-cloud'), false);
  const server = await startWeb(hub, { port: 0 });
  const { port } = server.address();
  const get = async (headers) => (await fetch(`http://127.0.0.1:${port}/api/state`, { headers })).json();
  assert.ok((await get({})).sessions.some((s) => s.provider === 'devin-cloud'));
  const foreign = await get({ origin: 'http://localhost:9999' });
  assert.equal(foreign.sessions.some((s) => s.provider === 'devin-cloud'), false);
  assert.equal(foreign.providers.some((p) => p.id === 'devin-cloud'), false);
  server.close();
  hub.stop();
});

test('claude: transcripts older than the window are dropped on rescan', () => {
  const dir = tmp();
  const proj = path.join(dir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', sessionId: 's1', requestId: 'r', timestamp: new Date().toISOString(), message: { id: 'm', model: 'claude-opus-4-5', usage: { input_tokens: 1, output_tokens: 2 } } }) + '\n');
  const store = new ClaudeStore({ roots: [dir], sinceHours: 1 }).loadOnce();
  assert.equal(store.snapshot().sessions.length, 1);
  const old = (Date.now() - 2 * 3600 * 1000) / 1000;
  fs.utimesSync(file, old, old);
  store.scan();
  assert.equal(store.snapshot().sessions.length, 0);
});
