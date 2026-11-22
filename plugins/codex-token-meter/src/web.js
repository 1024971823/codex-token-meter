import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MAX_BODY = 16 * 1024;
const isLocalOrigin = (origin, allowedHosts) => {
  try {
    return allowedHosts.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

export function startWeb(store, { port = 4399, host = '127.0.0.1' } = {}) {
  const clients = new Set();
  // The session the user last interacted with in Codex (reported by the plugin hooks).
  let focus = null;
  const snapshot = (limit = 30) => ({ ...store.snapshot({ limit }), focus });
  let pending = null;
  const broadcast = () => {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) {
      try {
        res.write(data);
      } catch {
        clients.delete(res);
      }
    }
  };
  const push = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast();
    }, 150);
  };
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host.includes(':') ? `[${host}]` : host]);

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return res.writeHead(400).end('bad request');
    }
    // Reject foreign Host headers (DNS rebinding) unless explicitly bound to all interfaces.
    const reqHost = (req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '0.0.0.0' && host !== '::' && !allowedHosts.has(reqHost)) {
      return res.writeHead(403).end('forbidden host');
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(snapshot(Number(url.searchParams.get('limit')) || 30)));
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      res.on('error', () => clients.delete(res));
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/focus' && req.method === 'POST') {
      // Browsers always send Origin on cross-site POSTs; only the local CLI/hook or our own pages may set focus.
      if (req.headers.origin && !isLocalOrigin(req.headers.origin, allowedHosts)) return res.writeHead(403).end('forbidden origin');
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          return res.writeHead(400).end('bad json');
        }
        const id = data.session_id || data.sessionId;
        if (typeof id !== 'string' || !id) return res.writeHead(400).end('missing session_id');
        focus = { sessionId: id, cwd: typeof data.cwd === 'string' ? data.cwd : null, event: data.hook_event_name || null, at: Date.now() };
        res.writeHead(204).end();
        broadcast();
      });
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, app: 'codex-token-meter', codexHome: store.codexHome }));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(WEB_DIR, 'index.html')).pipe(res);
    }
    if (url.pathname === '/mini' || url.pathname === '/mini.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(WEB_DIR, 'mini.html')).pipe(res);
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      store.on('change', push);
      setInterval(() => { if (clients.size) broadcast(); }, 1000).unref();
      setInterval(() => {
        for (const res of clients) {
          try {
            res.write(': ping\n\n');
          } catch {
            clients.delete(res);
          }
        }
      }, 15000).unref();
      resolve(server);
    });
  });
}
