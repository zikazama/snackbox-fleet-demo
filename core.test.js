// Run with: npm test   (node --test)
process.env.DB_PATH = ':memory:';

const { World, priceFor } = await import('../lib/world.js');

const test = (await import('node:test')).default;
const assert = (await import('node:assert/strict')).default;

function freshWorld() {
  const w = new World();
  w.machines.forEach((m) => {
    m.online = true;
  });
  return w;
}

function saleEvent(overrides = {}) {
  return {
    event_id: overrides.event_id || 'evt-1',
    machine_id: 'SB-01',
    sku: 'COLA-330',
    qty: 1,
    list_price_cents: 350,
    final_price_cents: 280,
    discount_cents: 70,
    sold_at: Date.now(),
    config_version: 1,
    applied_promo_id: 'PR-1',
    ...overrides,
  };
}

test('promo prices only apply inside the window, on the right day', () => {
  const w = freshWorld();
  // Friday 15:00-17:00, 20% off drinks
  const promo = w.createPromo({ category: 'drinks', discountPct: 20, startMin: 900, endMin: 1020, days: [5] });
  const snap = w.snapshot;

  const friday = (h, m = 0) => Date.UTC(2026, 10, 20, h - 8, m, 0); // Friday, UTC+8 -> UTC
  assert.equal(priceFor(snap, 'COLA-330', friday(14, 59)).price, 350, 'before the window: list price');
  assert.equal(priceFor(snap, 'COLA-330', friday(15, 1)).price, 280, 'inside the window: 20% off');
  assert.equal(priceFor(snap, 'COLA-330', friday(17, 0)).price, 350, 'end is exclusive');
  assert.equal(priceFor(snap, 'CHIPS-120', friday(15, 30)).price, 400, 'other category untouched');

  const saturday = Date.UTC(2026, 10, 21, 7, 30, 0);
  assert.equal(priceFor(snap, 'COLA-330', saturday).price, 350, 'wrong day: list price');
  assert.equal(priceFor(snap, 'COLA-330', friday(15, 30)).promo.id, promo.id);
});

test('an offline machine keeps charging its cached config', () => {
  const w = freshWorld();
  const machine = w.byId('SB-01');
  const before = priceFor(machine.snapshot, 'COLA-330', Date.UTC(2026, 10, 20, 7, 30, 0));

  w.createPromo({ category: 'drinks', discountPct: 50, startMin: 900, endMin: 1020, days: [5] });
  const stillOld = priceFor(machine.snapshot, 'COLA-330', Date.UTC(2026, 10, 20, 7, 30, 0));
  assert.equal(stillOld.price, before.price, 'machine has not synced yet');

  w._syncConfig(machine);
  const synced = priceFor(machine.snapshot, 'COLA-330', Date.UTC(2026, 10, 20, 7, 30, 0));
  assert.equal(synced.price, 175, 'after sync it uses the new promo');
});

test('retried batches never double count revenue or stock', () => {
  const w = freshWorld();
  const events = [saleEvent({ event_id: 'a' }), saleEvent({ event_id: 'b' }), saleEvent({ event_id: 'c' })];

  const first = w.store.applyBatch(events);
  assert.equal(first.accepted, 3);
  assert.equal(first.duplicates, 0);

  // Same batch again (lost ACK -> the machine retries the exact same event_ids).
  const second = w.store.applyBatch(events);
  assert.equal(second.accepted, 0);
  assert.equal(second.duplicates, 3);

  const stats = w.store.stats();
  assert.equal(stats.accepted, 3);
  assert.equal(stats.revenueCents, 3 * 280);
});

test('the outbox keeps events until the cloud acknowledges them', () => {
  const w = freshWorld();
  w.store.enqueue('SB-01', saleEvent({ event_id: 'x1' }));
  w.store.enqueue('SB-01', saleEvent({ event_id: 'x2' }));
  assert.equal(w.store.outboxCounts()['SB-01'], 2);

  const batch = w.store.pending('SB-01', 50);
  assert.equal(batch.length, 2);

  w.store.ack('SB-01', ['x1']);
  assert.equal(w.store.outboxCounts()['SB-01'], 1);
});

test('a dropped response leaves the batch in the outbox, and the retry is deduped', () => {
  const w = freshWorld();
  w.chaos.ackDrop = true;
  w.store.enqueue('SB-01', saleEvent({ event_id: 'chaos-1' }));
  const realRandom = Math.random;
  Math.random = () => 0.01; // force the "drop the ACK" branch
  try {
    assert.throws(() => w._flushSales(w.byId('SB-01'), Date.now()));
  } finally {
    Math.random = realRandom;
  }
  assert.equal(w.store.outboxCounts()['SB-01'], 1, 'machine still owns the event');

  w.chaos.ackDrop = false;
  w.byId('SB-01').nextAttemptAt = 0;
  w._flushSales(w.byId('SB-01'), Date.now());
  assert.equal(w.store.outboxCounts()['SB-01'], 0, 'drained on retry');
  assert.equal(w.counters.duplicatesBlocked, 1, 'the retry was recognised as a duplicate');
  assert.equal(w.store.stats().revenueCents, 280, 'counted once');
});

test('a bad firmware build halts the rollout at the canary', () => {
  const w = freshWorld();
  const realRandom = Math.random;
  Math.random = () => 0.1; // 0.1 < 0.75 => every canary machine fails its health check
  try {
    w.startOta({ version: '9.9.9', badFirmware: true });
    let at = w.simMs;
    for (let i = 0; i < 120 && w.ota.state === 'rolling'; i++) {
      at += 60_000;
      w._step(at);
    }
  } finally {
    Math.random = realRandom;
  }
  assert.equal(w.ota.state, 'halted');
  assert.ok(w.ota.haltedReason.includes('failed health checks'));
  const untouched = w.machines.filter((m) => m.fw === '1.4.0').length;
  assert.ok(untouched >= 18, `only the canary was exposed, got ${untouched} untouched`);
});

test('a healthy rollout reaches the whole fleet', () => {
  const w = freshWorld();
  const realRandom = Math.random;
  Math.random = () => 0.5; // 0.5 > 0.02 => everyone passes
  try {
    w.startOta({ version: '1.5.1' });
    let at = w.simMs;
    for (let i = 0; i < 600 && w.ota.state !== 'done'; i++) {
      at += 60_000;
      w._step(at);
    }
  } finally {
    Math.random = realRandom;
  }
  assert.equal(w.ota.state, 'done');
  assert.equal(w.machines.filter((m) => m.fw === '1.5.1').length, w.machines.length);
});
