// Minimal stdio MCP server (newline-delimited JSON-RPC). It advertises a Codex TUI statusline
// entrypoint so the Codex CLI footer shows the displayed thread's token usage, and a read-only
// `token_usage` tool for the model.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtNum, fmtCost } from './format.js';
import { findSession, countAgents, isRunning } from './session.js';

export const STATUSLINE_URI = 'ui://codex-token-meter/statusline';
export const WIDGET_URI = 'ui://codex-token-meter/widget';
const STATE_META = 'com.openai/codex-statusline-state';
const WIDGET_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'widget.html');

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
    'openai/ui': {
      resourceUri: WIDGET_URI,
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      preferredDisplayMode: 'inline',
      entrypoints: [{ type: 'statusline', resourceUri: STATUSLINE_URI }],
    },
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

export function handleRequest(store, msg, env = process.env) {
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: p.protocolVersion || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'codex-token-meter', version: '0.2.1' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      if (p.name !== TOOL.name) throw rpcError(-32602, `unknown tool ${p.name}`);
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

export function runMcp(store, { input = process.stdin, output = process.stdout } = {}) {
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
      send({ jsonrpc: '2.0', id: msg.id, result: handleRequest(store, msg) });
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: e.rpcCode || -32603, message: e.message } });
    }
  });
  rl.on('close', () => {
    store.stop();
    process.exit(0);
  });
}
