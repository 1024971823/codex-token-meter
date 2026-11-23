import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RolloutStore } from '../plugins/codex-token-meter/src/store.js';
import {
  PANEL_URI,
  PANEL_MIME_TYPE,
  PANEL_TOOL,
  STATUSLINE_URI,
  handleRequest,
  loadPanelHtml,
} from '../plugins/codex-token-meter/src/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, 'fixtures');
const BIN = path.join(HERE, '..', 'plugins', 'codex-token-meter', 'bin', 'codex-token-meter.js');
const ROOT = '01a1fe12-34b9-7990-9a0a-7f60cf77517a';
const load = () => new RolloutStore({ codexHome: HOME, sinceHours: 1e7 }).loadOnce();
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('panel tool: thread + global entrypoints on one UI resource, token_usage still first', () => {
  const tools = handleRequest(load(), { method: 'tools/list' }).tools;
  assert.equal(tools[0].name, 'token_usage');
  assert.equal(tools[0]._meta['openai/ui'], undefined);
  const statusline = tools.find((t) => t.name === 'token_meter_statusline');
  assert.deepEqual(statusline._meta['openai/ui'].entrypoints, [{ type: 'statusline', resourceUri: STATUSLINE_URI }]);
  const panel = tools.find((t) => t.name === 'token_meter_panel');
  assert.equal(panel, PANEL_TOOL);
  // Title must describe the view, not repeat the plugin name (spec guidance).
  assert.equal(panel.title, 'Token Meter Panel');
  assert.equal(panel._meta.ui.resourceUri, PANEL_URI);
  assert.deepEqual(panel._meta['openai/ui'].entrypoints, [{ type: 'thread' }, { type: 'global' }]);
  // Entrypoint opens carry no arguments: {} must be a valid input.
  assert.equal(panel.inputSchema.type, 'object');
  assert.equal(panel.annotations.readOnlyHint, true);
});

test('panel resource: listed and read as an MCP App HTML resource', () => {
  const store = load();
  const listed = handleRequest(store, { method: 'resources/list' }).resources;
  const panel = listed.find((r) => r.uri === PANEL_URI);
  assert.equal(panel.mimeType, PANEL_MIME_TYPE);
  assert.equal(panel.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(panel._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);

  const read = handleRequest(store, { method: 'resources/read', params: { uri: PANEL_URI } });
  const item = read.contents[0];
  assert.equal(item.uri, PANEL_URI);
  assert.equal(item.mimeType, PANEL_MIME_TYPE);
  assert.equal(item._meta['openai/ui'].preferredDisplayMode, 'inline');
  assert.match(item.text, /<!doctype html>/i);
  assert.equal(item.text, loadPanelHtml());
});

test('panel HTML: MCP Apps bridge only — no localhost, fetch, SSE or PiP', () => {
  const html = loadPanelHtml();
  assert.match(html, /ui\/initialize/);
  assert.match(html, /ui\/notifications\/initialized/);
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /tools\/call/);
  assert.match(html, /token_meter_panel/);
  // The header comment names the forbidden mechanisms in prose, so strip
  // comments first and assert on the executable code only.
  const code = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /127\.0\.0\.1/);
  assert.doesNotMatch(code, /localhost/);
  assert.doesNotMatch(code, /fetch\s*\(/);
  assert.doesNotMatch(code, /EventSource/);
  assert.doesNotMatch(code, /documentPictureInPicture/);
  assert.doesNotMatch(code, /\/api\/state/);
  assert.doesNotMatch(code, /\/api\/events/);
  // And the prose itself must not contain the literal loopback address either.
  assert.doesNotMatch(html, /127\.0\.0\.1/);
  assert.doesNotMatch(html, /localhost/);
});

test('panel tool: {} returns the full snapshot as structuredContent, with costs', () => {
  const store = load();
  const res = handleRequest(store, { method: 'tools/call', params: { name: 'token_meter_panel', arguments: {} } });
  const sc = res.structuredContent;
  assert.equal(sc.pricing.date, '2026-11-22');
  assert.equal(sc.pricing.currency, 'USD');
  // Fixture totals: 52,078 tokens, all gpt-5.1-codex, ~$0.076.
  assert.equal(sc.totals.all.total, 52078);
  assert.ok(approx(sc.totals.cost, 0.075980375, 1e-9), `totals.cost ${sc.totals.cost}`);
  assert.equal(sc.totals.costPriced, true);
  assert.equal(sc.totals.currency, 'USD');
  const root = sc.sessions[0];
  assert.equal(root.id, ROOT);
  assert.ok(approx(root.subtreeCost, sc.totals.cost, 1e-9));
  assert.equal(root.costPriced, true);
  // Per-agent costs add up to the session total.
  const kids = root.children.reduce((a, c) => a + c.cost, 0);
  assert.ok(approx(root.cost + kids, root.subtreeCost, 1e-9));
  assert.match(res.content[0].text, /Panel totals: 52078 tokens, estimated cost \$0\.076 USD/);
  // An explicit session id focuses the text summary on that session.
  const focused = handleRequest(store, { method: 'tools/call', params: { name: 'token_meter_panel', arguments: { session_id: ROOT } } });
  assert.match(focused.content[0].text, new RegExp(`Session ${ROOT}`));
  assert.equal(focused.structuredContent.sessions[0].id, ROOT);
});

test('panel tool: unknown model shows null cost, never $0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-panel-unknown-'));
  const day = path.join(home, 'sessions', '2026', '11', '21');
  fs.mkdirSync(day, { recursive: true });
  const line = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
  fs.writeFileSync(
    path.join(day, 'rollout-2026-11-21T00-00-00-u.jsonl'),
    line('session_meta', { id: 'u', source: 'cli' }) +
      line('turn_context', { model: 'gpt-99-future' }) +
      line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1100 }, last_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } } }),
  );
  const store = new RolloutStore({ codexHome: home }).loadOnce();
  const res = handleRequest(store, { method: 'tools/call', params: { name: 'token_meter_panel', arguments: {} } });
  const sc = res.structuredContent;
  assert.equal(sc.sessions[0].cost, null);
  assert.equal(sc.sessions[0].costPriced, false);
  assert.equal(sc.totals.cost, null);
  assert.equal(sc.totals.costPriced, false);
  assert.match(res.content[0].text, /cost unknown model \(not priced, never \$0\)/);
  assert.doesNotMatch(res.content[0].text, /\$0\.00 USD/);
});

test('MCP stdio: panel resource and tool work over the real server process', async () => {
  const child = spawn(process.execPath, [BIN, 'mcp', '--codex-home', HOME, '--since', '1e7'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = [];
  let buf = '';
  const waitFor = (id) =>
    new Promise((resolve) => {
      const check = () => {
        const r = replies.find((x) => x.id === id);
        if (r) resolve(r);
        else setTimeout(check, 20);
      };
      check();
    });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'resources/read', params: { uri: PANEL_URI } });
  send({ id: 4, method: 'tools/call', params: { name: 'token_meter_panel', arguments: {} } });
  send({ id: 5, method: 'tools/call', params: { name: 'token_usage', arguments: { session_id: ROOT } } });
  assert.equal((await waitFor(1)).result.serverInfo.version, '0.4.0');
  const tools = (await waitFor(2)).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['token_usage', 'token_meter_panel', 'token_meter_statusline']);
  const panel = (await waitFor(3)).result.contents[0];
  assert.equal(panel.mimeType, 'text/html;profile=mcp-app');
  assert.match(panel.text, /ui\/initialize/);
  const call = (await waitFor(4)).result;
  assert.ok(approx(call.structuredContent.totals.cost, 0.075980375, 1e-9));
  assert.match((await waitFor(5)).result.content[0].text, /Planck \[explorer\]/);
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
});

test('panel tool: follows the calling thread, then hook focus, then the latest session', () => {
  const store = load();
  const call = (params, env = {}, ctx = {}) =>
    handleRequest(store, { method: 'tools/call', params: { name: 'token_meter_panel', arguments: {}, ...params } }, env, ctx).structuredContent;
  const child = store.snapshot({ limit: 1000 }).sessions[0].children[0].id;
  let sc = call({ _meta: { threadId: child } });
  assert.equal(sc.currentSessionId, ROOT);
  assert.equal(sc.currentSource, 'thread');
  sc = call({}, {}, { focus: { sessionId: ROOT } });
  assert.equal(sc.currentSource, 'focus');
  sc = call({ _meta: { threadId: 'nope' } }, {}, { focus: { sessionId: 'nope' } });
  assert.equal(sc.currentSessionId, ROOT);
  assert.equal(sc.currentSource, 'latest');
  sc = call({ arguments: { session_id: ROOT }, _meta: { threadId: 'nope' } });
  assert.equal(sc.currentSource, 'argument');
});

test('plugin stays on the .codex-plugin manifest so hooks keep loading (Codex / ChatGPT desktop)', () => {
  const dir = path.join(HERE, '..', 'plugins', 'codex-token-meter');
  // A root Agent Plugins plugin.json takes precedence, and Codex 0.171 skips hooks for that format.
  assert.ok(!fs.existsSync(path.join(dir, 'plugin.json')));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const manifest = read('.codex-plugin/plugin.json');
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.hooks, './hooks.json');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(read('.mcp.json').mcpServers['token-meter']);
});
