// Netlify Function entrypoint (v2 API: Request -> Response).
//
// Same router as server.js and api/index.js. Simulated time advances while a
// request is in flight, so the demo keeps working on an ephemeral serverless
// host: there is no background timer to rely on.

import { handle } from '../../lib/router.js';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (status, payload) =>
  new Response(JSON.stringify(payload), { status, headers });

export default async function handler(req) {
  const url = new URL(req.url);
  let body = {};

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const raw = await req.text();
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(400, { error: 'invalid json' });
    }
  }

  try {
    const result = handle(req.method, url.pathname, body, url.searchParams);
    return json(result.status, result.json);
  } catch (err) {
    console.error('[api]', err);
    return json(500, { error: String((err && err.message) || err) });
  }
}

// One function, every /api/* path, so the router sees the real pathname.
export const config = { path: '/api/*' };
