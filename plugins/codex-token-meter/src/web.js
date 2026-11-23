import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MAX_BODY = 16 * 1024;
// Same-origin only: another localhost port is a different (possibly untrusted) site.
const isSameOrigin = (origin, host) => {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

// Cloud-account data (Devin sessions fetched with the user's API key) is only
// served to our own pages, never to other origins reading the CORS-open state.
export function redactAccountData(snap) {
  if (!snap.byProvider || !snap.byProvider['devin-cloud']) return snap;
  const { 'devin-cloud': _hidden, ...byProvider } = snap.byProvider;
  return {
    ...snap,
    providers: (snap.providers || []).filter((p) => p.id !== 'devin-cloud'),
    sessions: snap.sessions.filter((s) => s.provider !== 'devin-cloud'),
    byProvider,
    totals: { ...snap.totals, acus: null },
  };
}

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
      // Read-only local data; CORS-open so sandboxed MCP app widgets (any origin) can poll it.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      const snap = snapshot(Number(url.searchParams.get('limit')) || 30);
      const crossOrigin = req.headers.origin && !isSameOrigin(req.headers.origin, req.headers.host);
      return res.end(JSON.stringify(crossOrigin ? redactAccountData(snap) : snap));
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
      if (req.headers.origin && !isSameOrigin(req.headers.origin, req.headers.host)) return res.writeHead(403).end('forbidden origin');
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
        if (!data || typeof data !== 'object') return res.writeHead(400).end('bad json');
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
      return res.end(JSON.stringify({ ok: true, app: 'codex-token-meter', codexHome: store.codexHome, providers: store.ids || ['codex'] }));
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
      const timers = [];
      server.on('close', () => {
        store.off('change', push);
        timers.forEach(clearInterval);
        clearTimeout(pending);
      });
      timers.push(setInterval(() => { if (clients.size) broadcast(); }, 1000).unref());
      timers.push(setInterval(() => {
        for (const res of clients) {
          try {
            res.write(': ping\n\n');
          } catch {
            clients.delete(res);
          }
        }
      }, 15000).unref());
      resolve(server);
    });
  });
}
