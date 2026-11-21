import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

export function startWeb(store, { port = 4399, host = '127.0.0.1' } = {}) {
  const clients = new Set();
  let pending = null;
  const push = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const data = `data: ${JSON.stringify(store.snapshot({ limit: 30 }))}\n\n`;
      for (const res of clients) res.write(data);
    }, 150);
  };
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host]);

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
      return res.end(JSON.stringify(store.snapshot({ limit: Number(url.searchParams.get('limit')) || 30 })));
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(store.snapshot({ limit: 30 }))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
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
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      store.on('change', push);
      setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();
      resolve(server);
    });
  });
}
