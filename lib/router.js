// One router, two entrypoints: `server.js` (node:http, local + Docker) and
// `api/index.js` (Vercel serverless). No framework, no dependencies.

import { world } from './world.js';

const ok = (json) => ({ status: 200, json });
const bad = (message, status = 400) => ({ status, json: { error: message } });

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {any} body  parsed JSON body (or {} )
 * @param {URLSearchParams} [query]
 */
export function handle(method, pathname, body = {}, query = new URLSearchParams()) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const route = `${method.toUpperCase()} ${path}`;

  // Every request is a chance to move simulated time forward.
  world.advance();

  switch (route) {
    case 'GET /api/state':
      return ok(world.state());

    case 'GET /api/health':
      return ok({
        ok: true,
        storage: world.store.kind,
        sim: world.simMs,
        machines: world.machines.length,
        uptimeSeconds: Math.round((Date.now() - world.bootedAt) / 1000),
      });

    // ---- the real machine <-> cloud contract (the simulator calls these in-process)

    case 'GET /api/v1/config': {
      const machineId = query.get('machineId') || 'unknown';
      return ok({
        machineId,
        version: world.configVersion,
        catalog: world.snapshot.catalog,
        promos: world.snapshot.promos,
        serverSimTime: world.simMs,
      });
    }

    case 'POST /api/v1/sales': {
      const machineId = String(body.machineId || '');
      if (!world.byId(machineId)) return bad('unknown machine', 404);
      const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
      if (!events.length) return bad('events[] required');
      for (const ev of events) {
        if (typeof ev.event_id !== 'string' || ev.machine_id !== machineId) return bad('event_id/machine_id mismatch');
      }
      try {
        return ok(world._ingest(machineId, events));
      } catch (err) {
        return { status: 502, json: { error: err.message, committed: true } };
      }
    }

    case 'POST /api/promos': {
      const days = Array.isArray(body.days) && body.days.length ? body.days.map((d) => clampInt(d, 0, 6, 5)) : [5];
      const promo = world.createPromo({
        category: ['all', 'drinks', 'snacks'].includes(body.category) ? body.category : 'all',
        discountPct: clampInt(body.discountPct, 1, 90, 20),
        startMin: clampInt(body.startMin, 0, 1439, 900),
        endMin: clampInt(body.endMin, 1, 1440, 1020),
        days,
        label: typeof body.label === 'string' ? body.label.slice(0, 120) : undefined,
      });
      return ok({ promo });
    }

    case 'POST /api/promos/revoke':
      return world.revokePromo(String(body.id || '')) ? ok({ ok: true }) : bad('unknown promo');

    case 'POST /api/machines/online': {
      const m = world.setOnline(String(body.id || ''), Boolean(body.online), 'operator toggle');
      return m ? ok({ ok: true }) : bad('unknown machine');
    }

    case 'POST /api/fleet': {
      const action = String(body.action || '');
      if (action === 'all-offline') {
        for (const m of world.machines) world.setOnline(m.id, false, 'operator: fleet offline');
        return ok({ ok: true });
      }
      if (action === 'all-online') {
        for (const m of world.machines) world.setOnline(m.id, true, 'operator: fleet online');
        return ok({ ok: true });
      }
      if (action === 'drop-random') {
        const count = clampInt(body.count, 1, world.machines.length, 5);
        // Pick the busiest machines so the outbox demo has something to show.
        const targets = [...world.machines]
          .filter((m) => m.online)
          .sort((a, b) => b.sales - a.sales)
          .slice(0, count);
        for (const m of targets) world.setOnline(m.id, false, 'operator: pulled the plug');
        return ok({ offline: targets.map((m) => m.id) });
      }
      return bad('unknown fleet action');
    }

    case 'POST /api/chaos':
      world.chaos.ackDrop = Boolean(body.ackDrop);
      world.log('warn', 'CHAOS_TOGGLED', null, world.chaos.ackDrop ? 'flaky 3G: 50% of committed responses will be dropped' : 'flaky 3G disabled');
      return ok({ chaos: world.chaos });

    case 'POST /api/clock': {
      const minutes = clampInt(body.jumpMinutes, -10_080, 10_080, 0);
      if (!minutes) return bad('jumpMinutes required');
      world.jump(minutes);
      return ok({ sim: world.simMs, label: world.state().sim.label });
    }

    case 'POST /api/ota/start':
      if (world.ota.state === 'rolling') return bad('a rollout is already running');
      world.startOta({ version: String(body.version || '1.5.0').slice(0, 20), badFirmware: Boolean(body.badFirmware) });
      return ok({ ota: world.ota });

    case 'POST /api/ota/abort':
      return world.abortOta() ? ok({ ok: true }) : bad('no rollout in progress');

    case 'POST /api/reset':
      world.reset();
      return ok({ ok: true });

    default:
      return { status: 404, json: { error: `no route for ${route}` } };
  }
}
