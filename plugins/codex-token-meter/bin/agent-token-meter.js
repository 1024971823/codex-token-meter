#!/usr/bin/env node
// Standalone entry point: same CLI as codex-token-meter, but connects to every
// supported agent (Codex, Claude Code, Antigravity, Devin) by default.
process.env.AGENT_TOKEN_METER_DEFAULT = 'all';
await import('./codex-token-meter.js');
