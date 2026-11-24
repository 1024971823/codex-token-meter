import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RolloutStore } from '../plugins/codex-token-meter/src/store.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ROOT = '01a1fe12-34b9-7990-9a0a-7f60cf77517a';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-'));
  const day = path.join(home, 'sessions', '2026', '11', '21');
  fs.mkdirSync(day, { recursive: true });
  return { home, day };
}

const line = (type, payload, extra = {}) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload, ...extra }) + '\n';
const usage = (input, output, cached = 0, reasoning = 0) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output,
  reasoning_output_tokens: reasoning, total_tokens: input + output,
});

test('builds parent -> sub-agent tree from real Codex rollouts', () => {
  const snap = new RolloutStore({ codexHome: FIXTURES, sinceHours: 1e7 }).loadOnce().snapshot();
  assert.equal(snap.sessions.length, 1);
  const root = snap.sessions[0];
  assert.equal(root.id, ROOT);
  assert.equal(root.model, 'gpt-5.1-codex');
  assert.equal(root.usage.total, 16007);
  assert.equal(root.requests, 3);
  assert.equal(root.status, 'done');
  assert.deepEqual(root.children.map((c) => [c.nickname, c.role, c.usage.total]), [
    ['Planck', 'explorer', 18345],
    ['Socrates', 'worker', 17726],
  ]);
  assert.equal(snap.totals.subagents.total, 18345 + 17726);
  assert.equal(snap.totals.all.total, 16007 + 18345 + 17726);
  assert.equal(root.subtreeUsage.total, snap.totals.all.total);
  const u = root.children[0].usage;
  assert.equal(u.input + u.output, u.total);
});

test('tails appended lines live and emits change events', async () => {
  const { home, day } = tmpHome();
  const file = path.join(day, 'rollout-2026-11-21T00-00-00-child.jsonl');
  fs.writeFileSync(file, line('session_meta', {
    id: 'child', session_id: 'root', parent_thread_id: 'root', timestamp: new Date().toISOString(),
    source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_nickname: 'Ada', agent_role: 'worker' } } },
  }));
  const store = new RolloutStore({ codexHome: home, pollMs: 50, scanMs: 50 }).start();
  try {
    const changed = new Promise((resolve) => store.once('change', resolve));
    fs.appendFileSync(file, line('turn_context', { model: 'gpt-5-mini' }));
    // a partial line must not be parsed until it is complete
    const tc = line('event_msg', { type: 'token_count', info: { total_token_usage: usage(100, 20), last_token_usage: usage(100, 20) } });
    fs.appendFileSync(file, tc.slice(0, 30));
    await changed;
    fs.appendFileSync(file, tc.slice(30));
    await new Promise((r) => setTimeout(r, 200));
    const n = store.snapshot().sessions[0];
    assert.equal(n.nickname, 'Ada');
    assert.equal(n.model, 'gpt-5-mini');
    assert.equal(n.usage.total, 120);
    assert.deepEqual(n.byModel['gpt-5-mini'].total, 120);
  } finally {
    store.stop();
  }
});

test('ignores records inherited from a forked parent and other threads', () => {
  const { home, day } = tmpHome();
  fs.writeFileSync(
    path.join(day, 'rollout-2026-11-21T00-00-00-fork.jsonl'),
    line('session_meta', { id: 'fork', session_id: 'root', parent_thread_id: 'root', subagent_history_start_ordinal: 3,
      source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } } }, { ordinal: 0 }) +
      line('turn_context', { model: 'parent-model' }, { ordinal: 1 }) +
      line('event_msg', { type: 'token_count', info: { total_token_usage: usage(9000, 900), last_token_usage: usage(9000, 900) } }, { ordinal: 2 }) +
      line('turn_context', { model: 'child-model' }, { ordinal: 3 }) +
      line('token_usage_record', { thread_id: 'someone-else', usage: usage(1, 1), thread_token_usage: usage(1, 1) }, { ordinal: 4 }) +
      line('token_usage_record', { thread_id: 'fork', usage: usage(50, 5), thread_token_usage: usage(50, 5) }, { ordinal: 5 }) +
      line('event_msg', { type: 'token_count', info: { total_token_usage: usage(50, 5), last_token_usage: usage(50, 5) } }, { ordinal: 6 }),
  );
  const n = new RolloutStore({ codexHome: home }).loadOnce().snapshot().sessions[0];
  assert.equal(n.model, 'child-model');
  assert.equal(n.usage.total, 55);
  assert.equal(n.requests, 1);
  assert.deepEqual(Object.keys(n.byModel), ['child-model']);
});

test('falls back to token_count when token_usage_record is absent (older Codex)', () => {
  const { home, day } = tmpHome();
  fs.writeFileSync(
    path.join(day, 'rollout-2026-11-21T00-00-00-old.jsonl'),
    line('session_meta', { id: 'old', source: 'cli' }) +
      line('turn_context', { model: 'gpt-5' }) +
      line('event_msg', { type: 'token_count', info: { total_token_usage: usage(100, 10), last_token_usage: usage(100, 10) } }) +
      line('turn_context', { model: 'gpt-5-mini' }) +
      line('event_msg', { type: 'token_count', info: { total_token_usage: usage(300, 30), last_token_usage: usage(200, 20) } }),
  );
  const n = new RolloutStore({ codexHome: home }).loadOnce().snapshot().sessions[0];
  assert.equal(n.usage.total, 330);
  assert.equal(n.last.total, 220);
  assert.equal(n.byModel['gpt-5'].total, 110);
  assert.equal(n.byModel['gpt-5-mini'].total, 220);
});

test('global totals include sessions beyond the snapshot limit', () => {
  const { home, day } = tmpHome();
  for (const id of ['a', 'b', 'c']) {
    fs.writeFileSync(
      path.join(day, `rollout-2026-11-21T00-00-00-${id}.jsonl`),
      line('session_meta', { id, source: 'cli' }) +
        line('turn_context', { model: 'm' }) +
        line('event_msg', { type: 'token_count', info: { total_token_usage: usage(10, 1), last_token_usage: usage(10, 1) } }),
    );
  }
  const snap = new RolloutStore({ codexHome: home }).loadOnce().snapshot({ limit: 1 });
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.totals.all.total, 33);
});

test('finds recently resumed rollouts in old date directories', () => {
  const { home } = tmpHome();
  const old = path.join(home, 'sessions', '2020', '01', '01');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'rollout-2020-01-01T00-00-00-old.jsonl'), line('session_meta', { id: 'resumed', source: 'cli' }));
  const snap = new RolloutStore({ codexHome: home }).loadOnce().snapshot();
  assert.deepEqual(snap.sessions.map((s) => s.id), ['resumed']);
});

test('session_meta originator is exposed so desktop sessions are identifiable', () => {
  const { home, day } = tmpHome();
  fs.writeFileSync(
    path.join(day, 'rollout-2026-11-21T00-00-00-desk.jsonl'),
    line('session_meta', { id: 'desk', source: 'vscode', originator: 'Codex Desktop' }) +
      line('event_msg', { type: 'token_count', info: { total_token_usage: usage(10, 1), last_token_usage: usage(10, 1) } }),
  );
  const n = new RolloutStore({ codexHome: home }).loadOnce().snapshot().sessions[0];
  assert.equal(n.originator, 'Codex Desktop');
  assert.equal(n.source, 'vscode');
});
