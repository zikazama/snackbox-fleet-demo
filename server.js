// Local + Docker entrypoint: node server.js
// Serves the dashboard and the API from one process, and keeps simulated time
// moving even when nobody has the page open.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/router.js';
import { world, SIM_SPEED } from './lib/world.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const PAGE = fs.readFileSync(path.join(here, 'public', 'index.html'));
const STATIC = new Map([
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
  ['/shim.js', { file: 'shim.js', type: 'text/javascript; charset=utf-8' }],
  ['/engine.js', { file: 'engine.js', type: 'text/javascript; charset=utf-8' }],
]);

// Background tick: the sim also advances on every request, this just keeps it
// alive between page loads (and makes `curl` demos behave like the UI).
const ticker = setInterval(() => {
  try {
    world.advance();
  } catch (err) {
    console.error('[tick]', err);
  }
}, 250);
ticker.unref?.();

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, PAGE);
  }

  const asset = STATIC.get(url.pathname);
  if (asset) {
    try {
      const body = fs.readFileSync(path.join(here, 'public', asset.file));
      return send(res, 200, body, { 'content-type': asset.type });
    } catch {
      return send(res, 404, 'not found');
    }
  }

  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(res, 400, JSON.stringify({ error: 'invalid json' }), { 'content-type': 'application/json' });
      }
      try {
        const result = handle(req.method, url.pathname, body, url.searchParams);
        send(res, result.status, JSON.stringify(result.json), { 'content-type': 'application/json' });
      } catch (err) {
        console.error('[api]', err);
        send(res, 500, JSON.stringify({ error: String(err.message || err) }), { 'content-type': 'application/json' });
      }
    });
    return;
  }

  return send(res, 404, 'not found');
});

server.listen(PORT, () => {
  console.log(`SnackBox demo on http://localhost:${PORT}  (sim speed ${SIM_SPEED}x, storage ${world.store.kind})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(ticker);
    server.close(() => process.exit(0));
  });
}
