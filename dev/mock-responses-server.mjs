#!/usr/bin/env node
// Minimal OpenAI Responses API mock that drives Codex through a parent -> sub-agent flow,
// so real rollout files (with real sub-agent metadata) can be produced without an API key.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 18080);
const CHILD_DELAY_MS = Number(process.env.MOCK_CHILD_DELAY_MS || 1500);
const CHILD_STEPS = Number(process.env.MOCK_CHILD_STEPS || 3);
let seq = 0;

const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
  const input = rand(2000, 9000);
  const output = rand(100, 900);
  const reasoning = Math.floor(output * 0.4);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Math.floor(input * 0.6) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}

function sse(res, items) {
  const id = `resp_${++seq}`;
  const events = [{ type: 'response.created', response: { id } }];
  for (const item of items) events.push({ type: 'response.output_item.done', item });
  events.push({ type: 'response.completed', response: { id, usage: usage() } });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
}

const msg = (text) => ({ type: 'message', role: 'assistant', id: `msg_${++seq}`, content: [{ type: 'output_text', text }] });
const call = (call_id, name, args, namespace) => ({
  type: 'function_call', call_id, name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}),
});

function textOf(item) {
  if (!item) return '';
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map((c) => c.text || '').join('');
  if (typeof item.output === 'string') return item.output;
  return JSON.stringify(item);
}

async function handle(body, res) {
  const input = Array.isArray(body.input) ? body.input : [];
  const last = input[input.length - 1] || {};
  const lastUser = [...input].reverse().find((i) => i.type === 'message' && i.role === 'user');
  const userText = textOf(lastUser);
  const outputs = input.filter((i) => i.type === 'function_call_output');
  const childMatch = userText.match(/CHILD_TASK_(\w+)/);

  if (childMatch && !/SPAWN_TEST/.test(userText)) {
    await sleep(CHILD_DELAY_MS);
    const done = input.filter((i) => i.type === 'function_call_output' && String(i.call_id).startsWith('child-')).length;
    if (done + 1 < CHILD_STEPS) {
      return sse(res, [call(`child-${childMatch[1]}-${done}`, 'update_plan', { plan: [{ step: `step ${done}`, status: 'in_progress' }] })]);
    }
    return sse(res, [msg(`child ${childMatch[1]} finished`)]);
  }

  if (last.type === 'function_call_output') {
    if (String(last.call_id).startsWith('spawn-')) {
      const ids = outputs
        .filter((o) => String(o.call_id).startsWith('spawn-'))
        .map((o) => { try { return JSON.parse(textOf(o)).agent_id; } catch { return null; } })
        .filter(Boolean);
      return sse(res, [call('wait-1', 'wait_agent', { targets: ids, timeout_ms: 120000 }, 'multi_agent_v1')]);
    }
    if (String(last.call_id).startsWith('wait-')) return sse(res, [msg('all sub-agents done')]);
  }

  if (/SPAWN_TEST/.test(userText)) {
    return sse(res, [
      call('spawn-a', 'spawn_agent', { message: 'CHILD_TASK_alpha explore the repo', agent_type: 'explorer' }, 'multi_agent_v1'),
      call('spawn-b', 'spawn_agent', { message: 'CHILD_TASK_beta write tests', agent_type: 'worker' }, 'multi_agent_v1'),
    ]);
  }
  return sse(res, [msg('ok')]);
}

http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', async () => {
    if (process.env.MOCK_LOG) console.error(req.method, req.url, data.slice(0, 200));
    if (req.method === 'POST' && req.url.endsWith('/responses')) {
      try { await handle(JSON.parse(data || '{}'), res); } catch (e) { console.error(e); res.writeHead(500).end(); }
      if (!res.writableEnded) sse(res, [msg('ok')]);
      return;
    }
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[],"models":[]}'); }
    res.writeHead(404).end();
  });
}).listen(PORT, () => console.error(`mock responses server on :${PORT}`));
