import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RolloutStore } from '../plugins/codex-token-meter/src/store.js';
import { fmtCost } from '../plugins/codex-token-meter/src/format.js';
import {
  PRICING,
  estimateCost,
  estimateCostByModel,
  loadPricing,
  normalizeModelName,
} from '../plugins/codex-token-meter/src/pricing.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const usage = (input, output, cached = 0, reasoning = 0, cacheWrite = 0) => ({
  input, cached, cacheWrite, output, reasoning, total: input + output,
});

test('estimateCost: uncached input, cached input and output are priced separately', () => {
  // gpt-5: $1.25 / $0.125 / $10 per 1M tokens.
  const est = estimateCost(usage(2_000_000, 1_000_000, 1_000_000), 'gpt-5');
  assert.equal(est.currency, 'USD');
  assert.equal(est.priced, true);
  assert.ok(approx(est.breakdown.input, 1.25)); // 1M uncached
  assert.ok(approx(est.breakdown.cached, 0.125)); // 1M cached
  assert.ok(approx(est.breakdown.output, 10)); // 1M output
  assert.ok(approx(est.cost, 11.375));
});

test('estimateCost: cache-write tokens live inside input and are not double-counted', () => {
  // 2M input, 1M of it cached, 0.5M of it cache-write: only 1M uncached input
  // is charged at the input rate, and the cache-write tokens are part of it.
  const est = estimateCost(usage(2_000_000, 0, 1_000_000, 0, 500_000), 'gpt-5');
  assert.ok(approx(est.breakdown.input, 1.25));
  assert.ok(approx(est.breakdown.cached, 0.125));
  assert.ok(approx(est.cost, 1.375));
});

test('estimateCost: reasoning tokens are billed as output, not on top of it', () => {
  // output already includes reasoning (900k of the 1M output): charge 1M output once.
  const est = estimateCost(usage(0, 1_000_000, 0, 900_000), 'gpt-5');
  assert.ok(approx(est.breakdown.output, 10));
  assert.ok(approx(est.cost, 10));
});

test('estimateCost: unknown models return null, never $0', () => {
  assert.equal(estimateCost(usage(1_000_000, 1_000_000), 'gpt-99-future'), null);
  assert.equal(estimateCost(usage(1_000_000, 1_000_000), null), null);
  assert.equal(estimateCost(usage(1_000_000, 1_000_000), 'unknown'), null);
  assert.equal(fmtCost(null), '—');
  assert.equal(fmtCost(undefined), '—');
});

test('estimateCost: Codex model ids and dated snapshots map to the right price', () => {
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5.1-codex').cost, 1.25));
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5-codex').cost, 1.25));
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5-mini').cost, 0.25));
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5-nano').cost, 0.05));
  assert.ok(approx(estimateCost(usage(0, 1_000_000), 'gpt-4.1').cost, 8));
  assert.equal(normalizeModelName('gpt-5-2025-08-07'), 'gpt-5');
  assert.equal(normalizeModelName(' GPT-5-Codex '), 'gpt-5-codex');
  assert.ok(PRICING['gpt-5-codex'].input === 1.25 && PRICING['gpt-5-codex'].output === 10);
});

test('estimateCostByModel: partial pricing is flagged, not silently exact', () => {
  const byModel = {
    'gpt-5': usage(1_000_000, 0),
    'gpt-99-future': usage(1_000_000, 0),
  };
  const r = estimateCostByModel(byModel);
  assert.ok(approx(r.cost, 1.25)); // only the priced model contributes
  assert.equal(r.priced, false);
  assert.equal(r.pricedCount, 1);
  const all = estimateCostByModel({ 'gpt-5': usage(1_000_000, 0) });
  assert.equal(all.priced, true);
});

test('loadPricing: env JSON and --pricing-file override built-in prices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-pricing-'));
  const file = path.join(dir, 'pricing.json');
  fs.writeFileSync(file, JSON.stringify({ 'gpt-5': { input: 2, cached: 0.2, output: 20 }, 'gpt-99-future': { input: 1, cached: 0.1, output: 1 } }));
  const fromFile = loadPricing({ pricingFile: file, env: {} });
  assert.equal(fromFile.source, 'file');
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5', fromFile.table).cost, 2));
  assert.ok(approx(estimateCost(usage(0, 1_000_000), 'gpt-99-future', fromFile.table).cost, 1));
  // A file override wins over the env var.
  const both = loadPricing({ pricingFile: file, env: { CODEX_TOKEN_METER_PRICING: JSON.stringify({ 'gpt-5': { input: 99, cached: 99, output: 99 } }) } });
  assert.equal(both.source, 'file');
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5', both.table).cost, 2));

  const fromEnv = loadPricing({ env: { CODEX_TOKEN_METER_PRICING: JSON.stringify({ 'gpt-5': { input: 3, cached: 0.3, output: 30 } }) } });
  assert.equal(fromEnv.source, 'env');
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5', fromEnv.table).cost, 3));
  // Unmentioned models keep their built-in price.
  assert.ok(approx(estimateCost(usage(1_000_000, 0), 'gpt-5-mini', fromEnv.table).cost, 0.25));

  const builtin = loadPricing({ env: {} });
  assert.equal(builtin.source, 'builtin');
  assert.throws(() => loadPricing({ env: { CODEX_TOKEN_METER_PRICING: '{not json' } }), /JSON/);
});

test('fmtCost formats small and large amounts without losing the cents', () => {
  assert.equal(fmtCost(0), '$0.00');
  assert.equal(fmtCost(0.0035), '$0.0035');
  assert.equal(fmtCost(0.0759), '$0.076');
  assert.equal(fmtCost(1.234), '$1.23');
  assert.equal(fmtCost(1234.56), '$1,234.56');
});

test('snapshot: totals, per-model and per-session costs agree', () => {
  const snap = new RolloutStore({ codexHome: FIXTURES, sinceHours: 1e7 }).loadOnce().snapshot();
  assert.equal(snap.pricing.currency, 'USD');
  assert.equal(snap.pricing.date, '2026-11-22');
  // Fixture totals: 47,194 input (28,313 cached), 4,884 output, all gpt-5.1-codex.
  // (47,194-28,313)*1.25 + 28,313*0.125 + 4,884*10, all per 1M tokens.
  const expected = (18881 * 1.25 + 28313 * 0.125 + 4884 * 10) / 1e6;
  assert.ok(approx(snap.totals.cost, expected, 1e-9), `totals.cost ${snap.totals.cost} != ${expected}`);
  assert.equal(snap.totals.costPriced, true);
  assert.ok(approx(snap.totals.byModel['gpt-5.1-codex'].cost, expected, 1e-9));
  assert.equal(snap.totals.byModel['gpt-5.1-codex'].priced, true);
  assert.ok(approx(snap.totals.subagents.cost, snap.totals.cost - snap.sessions[0].cost, 1e-9));
  const root = snap.sessions[0];
  assert.ok(approx(root.subtreeCost, snap.totals.cost, 1e-9));
  assert.equal(root.subtreeCostPriced, true);
  // Per-node costs add up to the session total.
  const kids = root.children.reduce((a, c) => a + c.cost, 0);
  assert.ok(approx(root.cost + kids, root.subtreeCost, 1e-9));
  // Usage fields are untouched by the cost integration.
  assert.equal(snap.totals.all.total, 52078);
});

test('snapshot: a counter reset re-prices from the new baseline', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-reset-'));
  const day = path.join(home, 'sessions', '2026', '11', '21');
  fs.mkdirSync(day, { recursive: true });
  const line = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
  const rec = (input, output) => line('token_usage_record', {
    thread_id: 'r', usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
    thread_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
  });
  fs.writeFileSync(
    path.join(day, 'rollout-2026-11-21T00-00-00-r.jsonl'),
    line('session_meta', { id: 'r', source: 'cli' }) +
      line('turn_context', { model: 'gpt-5-mini' }) +
      rec(1_000_000, 1_000_000) +
      // Counter reset: cumulative total drops; the store accepts the new baseline.
      rec(100_000, 10_000),
  );
  const n = new RolloutStore({ codexHome: home }).loadOnce().snapshot().sessions[0];
  assert.equal(n.usage.total, 110_000);
  // gpt-5-mini: $0.25 in / $2 out per 1M. The pre-reset tokens were really
  // consumed, so the cost is the pre-reset segment plus the new baseline —
  // the reset must not freeze the cost at the old value, nor discard it.
  const beforeReset = (1_000_000 * 0.25 + 1_000_000 * 2) / 1e6;
  const afterReset = (100_000 * 0.25 + 10_000 * 2) / 1e6;
  assert.ok(approx(n.cost, beforeReset + afterReset, 1e-9), `cost ${n.cost} != ${beforeReset + afterReset}`);
  assert.ok(n.cost > beforeReset);
  assert.equal(n.costPriced, true);
});

test('snapshot: an unpriced model shows null cost, never $0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-unknown-'));
  const day = path.join(home, 'sessions', '2026', '11', '21');
  fs.mkdirSync(day, { recursive: true });
  const line = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
  fs.writeFileSync(
    path.join(day, 'rollout-2026-11-21T00-00-00-u.jsonl'),
    line('session_meta', { id: 'u', source: 'cli' }) +
      line('turn_context', { model: 'gpt-99-future' }) +
      line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1100 }, last_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } } }),
  );
  const snap = new RolloutStore({ codexHome: home }).loadOnce().snapshot();
  const n = snap.sessions[0];
  assert.equal(n.cost, null);
  assert.equal(n.costPriced, false);
  assert.equal(n.subtreeCost, null);
  assert.equal(snap.totals.cost, null);
  assert.equal(snap.totals.costPriced, false);
});
