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
   Each node also carries an estimated USD cost: `cost` (number, or `null` when its model is
   unpriced — never report $0 for an unpriced model), `costPriced` (false when only part of the
   node is priced), `subtreeCost` / `subtreeCostPriced` for the whole session tree, and
   `totals.cost` / `totals.byModel[<model>].cost`. `snapshot.pricing` gives the pricing date and
   source. Costs are estimates from OpenAI list prices, not a bill; say so when reporting them.
   Custom pricing can be supplied with `--pricing-file <file>` or the
   `CODEX_TOKEN_METER_PRICING` env var (JSON); see README “费用估算”.
3. The current session is normally the first entry in `sessions`. Report the sub-agents of that
   session as a short table: agent, role, model, input, output, total.

If the `token-meter` MCP tool `token_usage` is available, prefer calling it: it returns the
current session's per-agent usage directly.

## Desktop in-app panel (0.3.0, prototype)

The MCP server also exposes a `token_meter_panel` tool with `thread` and `global`
entrypoints (OpenAI MCP Extensions): in Codex Desktop it opens the same compact
usage-and-cost panel inside the app — as a content tab / side panel inside a
conversation, or from the sidebar. The panel UI is the resource
`ui://codex-token-meter/panel` (`text/html;profile=mcp-app`); it gets all data
from the tool's `structuredContent` over the MCP Apps bridge and refreshes by
re-calling the tool. It is a prototype and has NOT been verified inside the
real Codex Desktop app — if the user says an entrypoint does not appear or the
panel is blank, ask for their Desktop version and what they saw; the floating
mini window remains the fallback for CLI/IDE use.

## Opening the live dashboard

- Floating mini window (follows the session the user is typing in, can stay on top of Codex):
  run `node <plugin root>/bin/codex-token-meter.js mini`, or tell the user to open
  http://127.0.0.1:4399/mini and click “置顶”.

- Web dashboard: `node <plugin root>/bin/codex-token-meter.js ensure-web`, then tell the user to
  open http://127.0.0.1:4399 (the plugin's SessionStart hook normally starts it already).
- Terminal dashboard: tell the user to run `node <plugin root>/bin/codex-token-meter.js` in a
  separate terminal (it is interactive, do not run it yourself).
