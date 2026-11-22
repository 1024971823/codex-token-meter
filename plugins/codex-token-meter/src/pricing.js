// Cost estimation for Codex token usage.
//
// Prices are OpenAI API list prices in USD per 1M tokens, checked against
// the official pricing page (https://platform.openai.com/docs/pricing) on
// 2026-11-22. The official page is the source of truth: list prices change
// often, models are retired, and Codex/ChatGPT subscription pricing is a
// different thing entirely — this is an *estimate*, never a bill.
//
// How the math works (see estimateCost):
// - input_tokens already includes cached_input_tokens and
//   cache_write_input_tokens, so uncached input = input - cached. Charging
//   cache-write tokens at the standard input rate inside the input line
//   means they are never double-counted; there is no separate cache-write
//   charge (the rollout records do not carry a cache TTL, so OpenAI's
//   separate cache-write rates cannot be applied faithfully).
// - output_tokens already includes reasoning_output_tokens (reasoning is
//   billed as output), so output is charged once at the output rate.
// - Unknown models return null, never $0: reporting $0 would look like a
//   free session. Use a pricing override (see loadPricing) for those.

import fs from 'node:fs';

export const PRICING_DATE = '2026-11-22';
export const PRICING_SOURCE = 'https://platform.openai.com/docs/pricing';
export const PRICING_CURRENCY = 'USD';

// { input, cached, output } — USD per 1M tokens. `cacheWrite` is optional and
// defaults to `input` (see above); an override may set it explicitly.
export const PRICING = {
  // GPT-5 family (Codex's main line; gpt-5-codex is priced identically to gpt-5)
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-codex': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.1-codex': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.1-codex-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5.1-codex-max': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-5.2-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  // gpt-5.6-sol was on promotional pricing at least through 2026-11-30.
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  // GPT-4.1 family
  'gpt-4.1': { input: 2, cached: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  // GPT-6 family (named replacements for the GPT-5 line)
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6.2-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6.2-astra': { input: 8, cached: 0.4, output: 40 },
};

/** Normalizes a model id for lookup: lowercase, trims, drops a dated snapshot suffix. */
export function normalizeModelName(model) {
  if (!model || typeof model !== 'string') return null;
  let name = model.trim().toLowerCase();
  // gpt-5-2025-08-07 -> gpt-5 ; gpt-5-codex-2025-09-15 -> gpt-5-codex
  name = name.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return name || null;
}

export function getModelPricing(model, table = PRICING) {
  const name = normalizeModelName(model);
  if (!name || !table) return null;
  return table[name] || null;
}

function validRate(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function normalizePricingEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { input, cached, output, cacheWrite } = entry;
  if (!validRate(input) || !validRate(output)) return null;
  return {
    input,
    cached: validRate(cached) ? cached : input,
    output,
    ...(validRate(cacheWrite) ? { cacheWrite } : {}),
  };
}

/** Merges user-supplied pricing (model -> {input, cached, output}) over the built-in table. */
export function mergePricing(custom) {
  if (!custom || typeof custom !== 'object') return { ...PRICING };
  const table = { ...PRICING };
  const models = custom.models && typeof custom.models === 'object' ? custom.models : custom;
  for (const [model, entry] of Object.entries(models)) {
    const name = normalizeModelName(model);
    const priced = normalizePricingEntry(entry);
    if (name && priced) table[name] = priced;
  }
  return table;
}

/**
 * Resolves the pricing table. Precedence: --pricing-file > the
 * CODEX_TOKEN_METER_PRICING env var (JSON) > built-in table.
 * Returns { table, source: 'file' | 'env' | 'builtin', date }.
 * A malformed override throws, so a typo never silently falls back to stale prices.
 */
export function loadPricing({ pricingFile, env = process.env } = {}) {
  if (pricingFile) {
    const parsed = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    return { table: mergePricing(parsed), source: 'file', date: parsed.date || PRICING_DATE };
  }
  const raw = env.CODEX_TOKEN_METER_PRICING;
  if (raw) {
    const parsed = JSON.parse(raw);
    return { table: mergePricing(parsed), source: 'env', date: parsed.date || PRICING_DATE };
  }
  return { table: { ...PRICING }, source: 'builtin', date: PRICING_DATE };
}

/**
 * Estimates the cost of one usage record for one model.
 * Returns null for an unknown/unpriced model (never $0), otherwise
 * { cost, currency: 'USD', model, priced: true,
 *   breakdown: { input, cached, output } } — dollar amounts per component.
 * `usage` is the store's normalized shape {input, cached, cacheWrite, output, reasoning, total}.
 */
export function estimateCost(usage, model, table = PRICING) {
  const rate = getModelPricing(model, table);
  if (!rate) return null;
  const u = usage || {};
  const input = Math.max(0, u.input || 0);
  // cached is a subset of input; clamp so corrupt records cannot go negative.
  const cached = Math.min(Math.max(0, u.cached || 0), input);
  const uncached = input - cached;
  const output = Math.max(0, u.output || 0);
  // cacheWrite tokens are already inside `input` and are charged at the input
  // rate as part of the uncached line (see the header comment). Reasoning
  // tokens are already inside `output` and are charged at the output rate.
  const breakdown = {
    input: (uncached * rate.input) / 1e6,
    cached: (cached * rate.cached) / 1e6,
    output: (output * rate.output) / 1e6,
  };
  return {
    cost: breakdown.input + breakdown.cached + breakdown.output,
    currency: PRICING_CURRENCY,
    model: normalizeModelName(model),
    priced: true,
    breakdown,
  };
}

/** Sums estimateCost() over a {model -> usage} map. Returns {cost, priced} where priced is false if any model with usage is unpriced. */
export function estimateCostByModel(byModel, table = PRICING) {
  let cost = 0;
  let priced = true;
  let any = false;
  let pricedCount = 0;
  for (const [model, usage] of Object.entries(byModel || {})) {
    if (!usage || !(usage.total > 0)) continue;
    any = true;
    const est = estimateCost(usage, model, table);
    if (!est) {
      priced = false;
      continue;
    }
    pricedCount++;
    cost += est.cost;
  }
  // No usage at all costs $0 and is fully priced; a partial sum (some model
  // unpriced) keeps priced=false so callers never present it as exact.
  return { cost: any ? cost : 0, priced, any, pricedCount };
}
