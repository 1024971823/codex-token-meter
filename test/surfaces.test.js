import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RolloutStore } from '../plugins/codex-token-meter/src/store.js';
import { startWeb } from '../plugins/codex-token-meter/src/web.js';
import { handleRequest, statuslineTree, watchFocus, STATUSLINE_URI, WIDGET_URI } from '../plugins/codex-token-meter/src/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, 'fixtures');
const BIN = path.join(HERE, '..', 'plugins', 'codex-token-meter', 'bin', 'codex-token-meter.js');
const ROOT = '01a1fe12-34b9-7990-9a0a-7f60cf77517a';
const CHILD = '01a1fe12-3504-7db0-9dcb-8dbcf74cb255';
const load = () => new RolloutStore({ codexHome: HOME, sinceHours: 1e7 }).loadOnce();

test('statusline tree shows the displayed thread and its sub-agents', () => {
  const tree = statuslineTree(load().snapshot({ limit: 100 }), ROOT);
  assert.equal(tree.type, 'row');
  const flat = JSON.stringify(tree);
  assert.match(flat, /子代理 2/);
  assert.match(flat, /会话合计 52\.1k/);
  // A sub-agent thread shows its own usage but still reports the whole session.
  assert.match(JSON.stringify(statuslineTree(load().snapshot({ limit: 100 }), CHILD)), /18,345|18\.3k/);
});

test('token_usage uses the calling thread and never substitutes another session', () => {
  const store = load();
  const call = (params) => handleRequest(store, { method: 'tools/call', params: { name: 'token_usage', ...params } }, {}).content[0].text;
  assert.match(call({ arguments: {}, _meta: { threadId: CHILD } }), new RegExp(`Session ${ROOT}`));
  assert.match(call({ arguments: { session_id: 'nope' } }), /No token usage recorded for Codex session nope/);
});

test('MCP server advertises a statusline entrypoint and reads it for the requested thread', async () => {
  const store = load();
  const tools = handleRequest(store, { method: 'tools/list' }).tools;
  assert.equal(tools[0]._meta['openai/ui'], undefined);
  const statuslineTool = tools.find((t) => t.name === 'token_meter_statusline');
  assert.ok(statuslineTool);
  assert.deepEqual(statuslineTool._meta['openai/ui'].entrypoints, [{ type: 'statusline', resourceUri: STATUSLINE_URI }]);
  assert.equal(tools[0]._meta['openai/outputTemplate'], WIDGET_URI);

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
  send({ id: 2, method: 'resources/read', params: { uri: STATUSLINE_URI, _meta: { 'com.openai/codex-statusline-state': { thread: { id: ROOT } } } } });
  send({ id: 3, method: 'tools/call', params: { name: 'token_usage', arguments: { session_id: ROOT } } });
  send({ id: 4, method: 'resources/read', params: { uri: WIDGET_URI } });
  assert.equal((await waitFor(1)).result.serverInfo.name, 'codex-token-meter');
  const read = (await waitFor(2)).result.contents[0];
  assert.equal(read.mimeType, 'application/json');
  assert.match(read.text, /会话合计 52\.1k/);
  const call = (await waitFor(3)).result;
  assert.match(call.content[0].text, /Planck \[explorer\]/);
  assert.equal(call.structuredContent.session.id, ROOT);
  const widget = (await waitFor(4)).result.contents[0];
  assert.equal(widget.mimeType, 'text/html;profile=mcp-app');
  assert.match(widget.text, /api\/state/);
  assert.match(widget.text, new RegExp(ROOT));
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
});

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('web: /api/focus sets the followed session, rejects foreign origins, serves /mini', async () => {
  const server = await startWeb(load(), { port: 0 });
  const { port } = server.address();
  const post = (headers = {}) =>
    request(port, { method: 'POST', path: '/api/focus', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ session_id: CHILD, cwd: '/w', hook_event_name: 'UserPromptSubmit' }) });
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ origin: 'http://127.0.0.1:1' })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/api/focus', body: 'null' })).status, 400);
  assert.equal(JSON.parse((await request(port, { path: '/api/state' })).data).focus, null);
  assert.equal((await post()).status, 204);
  assert.equal((await post({ origin: `http://127.0.0.1:${port}` })).status, 204);
  const focus = JSON.parse((await request(port, { path: '/api/state' })).data).focus;
  assert.equal(focus.sessionId, CHILD);
  assert.equal(focus.event, 'UserPromptSubmit');
  const mini = await request(port, { path: '/mini' });
  assert.equal(mini.status, 200);
  assert.match(mini.data, /documentPictureInPicture/);
  const seen = await new Promise((resolve) => {
    const stop = watchFocus(port, (f) => { stop(); resolve(f); });
  });
  assert.equal(seen.sessionId, CHILD);
  server.close();
  const none = await new Promise((resolve) => {
    const stop = watchFocus(port, (f) => { stop(); resolve(f); });
  });
  assert.equal(none, null);
});
