---
name: token-meter
description: Show how many tokens Codex sub-agents (and the main agent) have used — input, cached input, output, reasoning, totals and which model each agent runs — or open the live token dashboard. Use when the user asks about token usage, cost, sub-agent consumption, or wants a live token monitor.
---

# Codex Token Meter

This plugin reads Codex rollout files under `$CODEX_HOME/sessions` (default `~/.codex/sessions`)
and reports per-agent token usage. The CLI lives next to this skill at
`<plugin root>/bin/codex-token-meter.js` (two directories above this file). Run it with `node`.

## Answering "how many tokens did the sub-agents use?"

1. Run `node <plugin root>/bin/codex-token-meter.js summary` for a readable summary, or
   `node <plugin root>/bin/codex-token-meter.js json` for the full snapshot.
2. In the JSON, `sessions[]` are root threads (most recent first). Each node has `name`, `role`,
   `model`, `status`, `usage` (`input`, `cached`, `output`, `reasoning`, `total`), `requests`, and
   `children` (its sub-agents). `totals.subagents` is the sum over all sub-agents, `totals.byModel`
   groups usage per model.
3. The current session is normally the first entry in `sessions`. Report the sub-agents of that
   session as a short table: agent, role, model, input, output, total.

## Opening the live dashboard

- Web dashboard: `node <plugin root>/bin/codex-token-meter.js ensure-web`, then tell the user to
  open http://127.0.0.1:4399 (the plugin's SessionStart hook normally starts it already).
- Terminal dashboard: tell the user to run `node <plugin root>/bin/codex-token-meter.js` in a
  separate terminal (it is interactive, do not run it yourself).
