// Minimal stdio MCP server (newline-delimited JSON-RPC). It advertises a Codex TUI statusline
// entrypoint so the Codex CLI footer shows the displayed thread's token usage, a read-only
// `token_usage` tool for the model (with an inline MCP App widget via `openai/outputTemplate`),
// and a desktop in-app panel (`token_meter_panel`) via OpenAI MCP Extensions entrypoints
// (thread side panel + global sidebar).
//
// No new runtime dependencies: the MCP Apps / MCP Extensions wire format used
// here is plain JSON-RPC (the `ui://` resources, `_meta.ui.resourceUri` and
// `_meta["openai/ui"].entrypoints`), so the official `@openai/mcp-extensions`
// SDK — a wrapper around the same protocol, for servers built on
// `@modelcontextprotocol/sdk`, which this hand-rolled server does not use —
// would be a rewrite, not a feature. The metadata below follows the spec at
// https://github.com/openai/mcp-extensions/blob/HEAD/docs/spec.md
// (verified 2026-11-22) and developers.openai.com/plugins/build/extensions.
import http from 'node:http';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtNum, fmtCost } from './format.js';
import { findSession, countAgents, isRunning } from './session.js';

export const STATUSLINE_URI = 'ui://codex-token-meter/statusline';
export const WIDGET_URI = 'ui://codex-token-meter/widget';
export const PANEL_URI = 'ui://codex-token-meter/panel';
export const PANEL_MIME_TYPE = 'text/html;profile=mcp-app';
const STATE_META = 'com.openai/codex-statusline-state';
const WIDGET_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'widget.html');

// The panel UI, read lazily from web/panel.html next to this file's parent dir.
// It is a single self-contained HTML file: no fetch(), no EventSource, no
// localhost URL — all data arrives over the MCP Apps bridge as the panel
// tool's structuredContent (see panel.html's header comment).
let panelHtmlCache = null;
export function loadPanelHtml() {
  if (panelHtmlCache === null) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'panel.html');
    panelHtmlCache = fs.readFileSync(file, 'utf8');
  }
  return panelHtmlCache;
}
export function resetPanelHtmlCache() { panelHtmlCache = null; }

const TOOL = {
  name: 'token_usage',
  title: 'Token Meter',
  description:
    'Token usage of a Codex session and its sub-agents: input / cached / output / reasoning / total tokens and model per agent, plus an estimated USD cost per agent (OpenAI list prices; unknown models show no cost, never $0). Defaults to the current session.',
  inputSchema: {
    type: 'object',
    properties: { session_id: { type: 'string', description: 'Codex thread/session id (optional).' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  _meta: {
    // ChatGPT / Codex desktop renders the template widget inline when this tool is called.
    'openai/outputTemplate': WIDGET_URI,
    'openai/widgetDescription': 'Live per-agent token usage and estimated cost for a Codex session.',
    ui: { resourceUri: WIDGET_URI },
    // No openai/ui here: the desktop validates it with a strict schema
    // ({entrypoints, preferredModelDisplayMode} only, entrypoint types
    // file|global|thread|deepLink|settings). Widget rendering only needs
    // openai/outputTemplate; the statusline entrypoint lives on its own tool.
  },
};

// The Codex CLI statusline is discovered via a {type:'statusline'} entrypoint in
// _meta["openai/ui"].entrypoints. Desktop rejects that type under its strict
// schema, so it lives on this dedicated tool — the desktop drops only this
// tool's UI metadata, leaving the widget (token_usage) and the panel entrypoints
// (token_meter_panel) intact.
export const STATUSLINE_TOOL = {
  name: 'token_meter_statusline',
  title: 'Token Meter Statusline',
  description:
    'Codex statusline provider: live token usage and estimated cost of the current session for the footer. Same data as token_usage.',
  inputSchema: {
    type: 'object',
    properties: { session_id: { type: 'string', description: 'Codex thread/session id (optional).' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  _meta: {
    ui: { resourceUri: STATUSLINE_URI },
    'openai/ui': { entrypoints: [{ type: 'statusline', resourceUri: STATUSLINE_URI }] },
  },
};

// Desktop in-app panel. One tool carries both entrypoints on the same UI:
//  - thread: a content tab / side panel inside a conversation — the closest
//    thing to an "internal small window" in the Codex desktop app.
//  - global: a sidebar entry that opens the same panel fullscreen.
// The server MUST accept {} as the arguments when an entrypoint opens, so
// session_id is optional; with no id the panel shows the most recent session
// and lets the user pick another one in the UI. (The entrypoint open carries
// no thread id, so the server cannot know which thread opened the panel.)
// Title is deliberately not the plugin name: the spec asks entrypoint titles
// to describe the view's contents.
export const PANEL_TOOL = {
  name: 'token_meter_panel',
  title: 'Token Meter Panel',
  description:
    'Open the Token Meter panel inside Codex Desktop or the ChatGPT desktop app: live token usage and estimated USD cost per agent, per model and per session. Returns the full snapshot as structuredContent for the panel UI, plus a text summary for hosts without UI. No arguments needed.',
  inputSchema: {
    type: 'object',
    properties: { session_id: { type: 'string', description: 'Codex thread/session id to focus (optional; defaults to the calling conversation, then the session the user last typed in, then the most recent one).' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  _meta: {
    ui: { resourceUri: PANEL_URI },
    'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] },
  },
};

const text = (children, props) => ({ type: 'text', ...(props ? { props } : {}), children });

/** Codex statusline UI tree for one session; `threadId` may be the root or a sub-agent. */
export function statuslineTree(snapshot, threadId) {
  const s = findSession(snapshot, threadId);
  if (!s) return text(['⛁ token meter: 等待本会话的 token 数据…'], { color: 'cyan' });
  const self = (function find(n) {
    if (n.id === threadId) return n;
    for (const c of n.children) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  })(s) || s;
  const u = self.usage;
  const costOf = (node) => (node.cost === null ? '—' : node.costPriced ? fmtCost(node.cost) : `~${fmtCost(node.cost)}`);
  const items = [
    text([`⛁ ${fmtNum(u.total)}`], { color: isRunning(self) ? 'green' : 'cyan', weight: 'bold' }),
    text([`in ${fmtNum(u.input)} (缓存 ${fmtNum(u.cached)}) · out ${fmtNum(u.output)} (推理 ${fmtNum(u.reasoning)})`]),
    text([`约 ${costOf(self)}`], { color: 'yellow' }),
  ];
  if (self.last.total) items.push(text([`本次 +${fmtNum(self.last.total)}`], { color: 'green' }));
  if (self.model) items.push(text([self.model], { color: 'yellow' }));
  const n = countAgents(s);
  if (n) {
    const sub = s.subtreeUsage.total - s.usage.total;
    const running = (function walk(x) { return x.children.reduce((a, c) => a + (c.status === 'running' ? 1 : 0) + walk(c), 0); })(s);
    items.push(text([`子代理 ${n}${running ? `(${running} 运行中)` : ''} ${fmtNum(sub)}`], { color: 'cyan' }));
    items.push(text([`会话合计 ${fmtNum(s.subtreeUsage.total)} · 约 ${s.subtreeCost === null ? '—' : s.subtreeCostPriced ? fmtCost(s.subtreeCost) : `~${fmtCost(s.subtreeCost)}`}`], { weight: 'bold' }));
  }
  return { type: 'row', props: { gap: 2 }, children: items };
}

export function usageReport(snapshot, threadId) {
  const s = threadId ? findSession(snapshot, threadId) : snapshot.sessions[0];
  if (!s) return threadId ? `No token usage recorded for Codex session ${threadId} (yet).` : 'No Codex sessions found.';
  const line = (u, cost, priced) =>
    `total ${u.total} (input ${u.input}, cached ${u.cached}, output ${u.output}, reasoning ${u.reasoning})` +
    (cost === null ? ', cost: unknown model (not priced)' : `, estimated cost ${priced ? '' : '~'}${fmtCost(cost)} USD`);
  const out = [`Session ${s.id} (${s.cwd || '-'})`];
  const walk = (n, indent) => {
    out.push(`${indent}${n.depth === 0 && !n.nickname ? 'main' : n.name} [${n.role || '-'}] ${n.model || '-'} ${n.status}: ${line(n.usage, n.cost, n.costPriced)}, ${n.requests} requests`);
    n.children.forEach((c) => walk(c, indent + '  '));
  };
  walk(s, '  ');
  out.push(`Session subtree: ${line(s.subtreeUsage, s.subtreeCost, s.subtreeCostPriced)}`);
  out.push('Costs are estimates from OpenAI list prices, not a bill. Unknown models are shown as unpriced, never $0.');
  return out.join('\n');
}

/**
 * Snapshot for the desktop panel: full structuredContent + a text summary.
 * `currentSessionId` is the session the panel shows in "auto" mode, resolved from (in order) an
 * explicit `session_id`, the calling thread (`_meta.threadId`), the session the user last typed in
 * (hook focus, read from the local dashboard) and finally the most recent session.
 */
export function panelToolResult(store, args = {}, { threadId = null, focus = null } = {}) {
  const snap = store.snapshot({ limit: 1000 });
  const pick = [
    [args.session_id, 'argument'],
    [threadId, 'thread'],
    [focus && focus.sessionId, 'focus'],
  ].find(([id]) => id && findSession(snap, id));
  const current = pick ? findSession(snap, pick[0]) : snap.sessions[0] || null;
  const currentSource = pick ? pick[1] : current ? 'latest' : null;
  const text = usageReport(snap, args.session_id || current?.id);
  const totals = snap.totals;
  const summary =
    totals.cost === null
      ? `${text}\nPanel totals: cost unknown model (not priced, never $0).`
      : `${text}\nPanel totals: ${totals.all.total} tokens, estimated cost ${totals.costPriced ? '' : '~'}${fmtCost(totals.cost)} USD (OpenAI list prices ${snap.pricing.date}; an estimate, not a bill).`;
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { ...snap, currentSessionId: current ? current.id : null, currentSource },
  };
}

export function handleRequest(store, msg, env = process.env, ctx = {}) {
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: p.protocolVersion || '2025-06-18',
        capabilities: {
          tools: {},
          resources: {},
          // MCP Apps extension advertisement (io.modelcontextprotocol/ui).
          // Hosts that do not understand it ignore it; the panel is also
          // discoverable via tools/list _meta and resources/list alone.
          extensions: { 'io.modelcontextprotocol/ui': {} },
        },
        serverInfo: { name: 'codex-token-meter', version: '0.4.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      // token_usage stays first: existing clients/tests read tools[0].
      return { tools: [TOOL, PANEL_TOOL, STATUSLINE_TOOL] };
    case 'tools/call': {
      if (p.name === PANEL_TOOL.name) {
        return panelToolResult(store, p.arguments || {}, {
          threadId: p._meta?.threadId || env.CODEX_THREAD_ID || null,
          focus: ctx.focus || null,
        });
      }
      if (p.name !== TOOL.name && p.name !== STATUSLINE_TOOL.name)
        throw rpcError(-32602, `unknown tool ${p.name}`);
      // Codex sends the calling thread as _meta.threadId on every MCP tool call.
      const id = p.arguments?.session_id || p._meta?.threadId || env.CODEX_THREAD_ID;
      const snap = store.snapshot({ limit: 1000 });
      const session = findSession(snap, id) || snap.sessions[0] || null;
      // structuredContent feeds window.openai.toolOutput so the widget has data instantly.
      return { content: [{ type: 'text', text: usageReport(snap, id) }], structuredContent: { session } };
    }
    case 'resources/list':
      return {
        resources: [
          { uri: STATUSLINE_URI, name: 'token-meter-statusline', mimeType: 'application/json' },
          { uri: WIDGET_URI, name: 'token-meter-widget', mimeType: 'text/html;profile=mcp-app' },
          {
            uri: PANEL_URI,
            name: 'token-meter-panel',
            mimeType: PANEL_MIME_TYPE,
            _meta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' } },
          },
        ],
      };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read': {
      const threadId = p._meta?.[STATE_META]?.thread?.id || env.CODEX_THREAD_ID;
      const snap = store.snapshot({ limit: 1000 });
      if (p.uri === WIDGET_URI) {
        const session = findSession(snap, threadId) || snap.sessions[0] || null;
        const port = Number(env.CODEX_TOKEN_METER_PORT) || 4399;
        const html = fs
          .readFileSync(WIDGET_HTML, 'utf8')
          .replaceAll('__API__', `http://127.0.0.1:${port}`)
          // Guard against `</script>` in embedded data terminating the script early.
          .replaceAll('__EMBED__', JSON.stringify({ session }).replaceAll('</', '<\\/'));
        return {
          contents: [
            {
              uri: WIDGET_URI,
              mimeType: 'text/html;profile=mcp-app',
              text: html,
              _meta: {
                ui: { permissions: { localNetwork: {}, loopbackNetwork: {} } },
                'openai/ui': { availableDisplayModes: ['inline', 'fullscreen', 'pip'], preferredDisplayMode: 'inline' },
                'openai/widgetCSP': { connect_domains: [`http://127.0.0.1:${port}`, `http://localhost:${port}`], resource_domains: [] },
              },
            },
          ],
        };
      }
      if (p.uri === PANEL_URI) {
        return {
          contents: [{
            uri: PANEL_URI,
            mimeType: PANEL_MIME_TYPE,
            text: loadPanelHtml(),
            // Spec: ChatGPT uses fullscreen for all entrypoints; the modes
            // below only matter when the model invokes the app inline.
            _meta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' } },
          }],
        };
      }
      if (p.uri !== STATUSLINE_URI) throw rpcError(-32002, `unknown resource ${p.uri}`);
      const tree = statuslineTree(snap, threadId);
      return { contents: [{ uri: STATUSLINE_URI, mimeType: 'application/json', text: JSON.stringify(tree) }] };
    }
    default:
      throw rpcError(-32601, `method not found: ${msg.method}`);
  }
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}

/** Polls the local dashboard's hook focus (the session the user last typed in); null when it is not running. */
export function watchFocus(port, onFocus, intervalMs = 2000) {
  const poll = () => {
    // /api/state carries `focus` on every dashboard version that has it (older ones lack GET /api/focus).
    const req = http.get({ host: '127.0.0.1', port, path: '/api/state?limit=1', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          onFocus(res.statusCode === 200 ? JSON.parse(body).focus || null : null);
        } catch {
          onFocus(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => onFocus(null));
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function runMcp(store, { input = process.stdin, output = process.stdout, env = process.env, port } = {}) {
  const ctx = { focus: null };
  const stopFocus = watchFocus(port || Number(env.CODEX_TOKEN_METER_PORT) || 4399, (f) => (ctx.focus = f));
  const rl = readline.createInterface({ input });
  const send = (obj) => output.write(JSON.stringify(obj) + '\n');
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined || msg.id === null) return; // notification
    try {
      send({ jsonrpc: '2.0', id: msg.id, result: handleRequest(store, msg, env, ctx) });
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: e.rpcCode || -32603, message: e.message } });
    }
  });
  rl.on('close', () => {
    stopFocus();
    store.stop();
    process.exit(0);
  });
}
