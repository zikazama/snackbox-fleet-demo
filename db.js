// Durable store for the cloud side and for the machine-side outbox.
//
// Two adapters, one interface:
//   * SqliteStore  - node:sqlite (bundled with Node, no native deps, no CGO).
//                    UNIQUE(sales.event_id) is the idempotency guarantee, and every
//                    batch is applied inside one BEGIN IMMEDIATE transaction.
//   * MemoryStore  - fallback for runtimes that do not ship the SQLite addon.
//                    Same semantics, expressed with a Map and a synchronous
//                    critical section (Node is single threaded, so the whole
//                    applyBatch body is atomic with respect to other requests).
//
// The interface is deliberately small so both adapters stay readable:
//   seedMachines(machines)   create the cloud-side projected stock rows
//   enqueue(machineId, ev)   write one sale to the machine's durable outbox
//   pending(machineId, n)    read up to n unsynced events, oldest first
//   ack(machineId, ids)      delete them only after the cloud said 200
//   applyBatch(events)       idempotent, atomic: accept new, ignore known ids
//   outboxCounts()           {machineId: pendingCount}
//   cloudStock()             {machineId: unitsCloudBelievesRemain}
//   stats()                  {accepted, units, revenueCents}
//   reset()                  drop everything

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let DatabaseSync = null;
try {
  // Only available when the Node build bundles SQLite (Node >= 22.5).
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sales (
  event_id          TEXT PRIMARY KEY,
  machine_id        TEXT NOT NULL,
  sku               TEXT NOT NULL,
  qty               INTEGER NOT NULL,
  list_price_cents  INTEGER NOT NULL,
  final_price_cents INTEGER NOT NULL,
  sold_at           INTEGER NOT NULL,
  arrived_at        INTEGER NOT NULL,
  applied_promo_id  TEXT,
  config_version    INTEGER
);
CREATE INDEX IF NOT EXISTS sales_machine ON sales(machine_id);
CREATE INDEX IF NOT EXISTS sales_sold_at ON sales(sold_at);

CREATE TABLE IF NOT EXISTS outbox (
  machine_id TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, event_id)
);
CREATE INDEX IF NOT EXISTS outbox_machine ON outbox(machine_id, created_at);

CREATE TABLE IF NOT EXISTS machine_stock (
  machine_id TEXT NOT NULL,
  sku        TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  PRIMARY KEY (machine_id, sku)
);
`;

/** Where the database file lives. Serverless filesystems are read-only except /tmp. */
function defaultDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.VERCEL) return '/tmp/snackbox.db';
  return path.join(process.cwd(), 'data', 'snackbox.db');
}

class SqliteStore {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.kind = 'sqlite';
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 4000');
    this.db.exec(SCHEMA);
    this._seed = this.db.prepare(
      'INSERT INTO machine_stock (machine_id, sku, qty) VALUES (?, ?, ?) ON CONFLICT(machine_id, sku) DO UPDATE SET qty = excluded.qty'
    );
    this._enqueue = this.db.prepare(
      'INSERT INTO outbox (machine_id, event_id, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'
    );
    this._pending = this.db.prepare(
      'SELECT payload FROM outbox WHERE machine_id = ? ORDER BY created_at LIMIT ?'
    );
    this._ack = this.db.prepare('DELETE FROM outbox WHERE machine_id = ? AND event_id = ?');
    this._insertSale = this.db.prepare(
      `INSERT INTO sales (event_id, machine_id, sku, qty, list_price_cents, final_price_cents, sold_at, arrived_at, applied_promo_id, config_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this._decStock = this.db.prepare(
      'UPDATE machine_stock SET qty = MAX(0, qty - ?) WHERE machine_id = ? AND sku = ?'
    );
  }

  seedMachines(machines) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of machines) {
        for (const [sku, qty] of Object.entries(m.stock)) this._seed.run(m.id, sku, qty);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  enqueue(machineId, ev) {
    this._enqueue.run(machineId, ev.event_id, JSON.stringify(ev), Date.now());
  }

  pending(machineId, limit) {
    return this._pending.all(machineId, limit).map((row) => JSON.parse(row.payload));
  }

  ack(machineId, ids) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) this._ack.run(machineId, id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * The whole point of the demo: one transaction, one PRIMARY KEY.
   * A retried batch is a no-op for rows that already exist, so a response that
   * is lost after commit can never double count revenue or stock.
   */
  applyBatch(events) {
    const arrivedAt = Date.now();
    const out = { accepted: 0, duplicates: 0, units: 0, revenueCents: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const ev of events) {
        try {
          this._insertSale.run(
            ev.event_id,
            ev.machine_id,
            ev.sku,
            ev.qty,
            ev.list_price_cents,
            ev.final_price_cents,
            ev.sold_at,
            arrivedAt,
            ev.applied_promo_id ?? null,
            ev.config_version ?? null
          );
        } catch (err) {
          if (String(err.message || err).includes('UNIQUE') || err.errcode === 1555 || err.errcode === 2067) {
            out.duplicates += 1;
            continue;
          }
          throw err;
        }
        out.accepted += 1;
        out.units += ev.qty;
        out.revenueCents += ev.final_price_cents * ev.qty;
        this._decStock.run(ev.qty, ev.machine_id, ev.sku);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return out;
  }

  outboxCounts() {
    const rows = this.db.prepare('SELECT machine_id, COUNT(*) AS c FROM outbox GROUP BY machine_id').all();
    return Object.fromEntries(rows.map((r) => [r.machine_id, Number(r.c)]));
  }

  cloudStock() {
    const rows = this.db.prepare('SELECT machine_id, SUM(qty) AS q FROM machine_stock GROUP BY machine_id').all();
    return Object.fromEntries(rows.map((r) => [r.machine_id, Number(r.q)]));
  }

  stats() {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(qty),0) AS u, COALESCE(SUM(final_price_cents * qty),0) AS r FROM sales')
      .get();
    return { accepted: Number(row.c), units: Number(row.u), revenueCents: Number(row.r) };
  }

  reset() {
    this.db.exec('DELETE FROM sales; DELETE FROM outbox; DELETE FROM machine_stock;');
  }
}

const obKey = (machineId, eventId) => `${machineId}\u0000${eventId}`;

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.sales = new Map(); // event_id -> row
    this.outbox = new Map(); // obKey(machineId, eventId) -> {machine_id, event_id, payload, created_at}
    this.stock = new Map(); // `${machineId}|${sku}` -> qty
    this.seq = 0;
  }

  seedMachines(machines) {
    for (const m of machines) {
      for (const [sku, qty] of Object.entries(m.stock)) this.stock.set(`${m.id}|${sku}`, qty);
    }
  }

  enqueue(machineId, ev) {
    this.outbox.set(`${machineId}\u0000${ev.event_id}`, {
      machine_id: machineId,
      event_id: ev.event_id,
      payload: JSON.stringify(ev),
      created_at: Date.now() + this.seq++,
    });
  }

  pending(machineId, limit) {
    const rows = [];
    for (const row of this.outbox.values()) {
      if (row.machine_id === machineId) rows.push(row);
    }
    rows.sort((a, b) => a.created_at - b.created_at);
    return rows.slice(0, limit).map((r) => JSON.parse(r.payload));
  }

  ack(machineId, ids) {
    for (const id of ids) this.outbox.delete(`${machineId}\u0000${id}`);
  }

  applyBatch(events) {
    const out = { accepted: 0, duplicates: 0, units: 0, revenueCents: 0 };
    // Synchronous body => atomic w.r.t. the event loop.
    for (const ev of events) {
      if (this.sales.has(ev.event_id)) {
        out.duplicates += 1;
        continue;
      }
      this.sales.set(ev.event_id, { ...ev, arrived_at: Date.now() });
      out.accepted += 1;
      out.units += ev.qty;
      out.revenueCents += ev.final_price_cents * ev.qty;
      const key = `${ev.machine_id}|${ev.sku}`;
      this.stock.set(key, Math.max(0, (this.stock.get(key) || 0) - ev.qty));
    }
    return out;
  }

  outboxCounts() {
    const counts = {};
    for (const row of this.outbox.values()) counts[row.machine_id] = (counts[row.machine_id] || 0) + 1;
    return counts;
  }

  cloudStock() {
    const total = {};
    for (const [key, qty] of this.stock) {
      const [machineId] = key.split('|');
      total[machineId] = (total[machineId] || 0) + qty;
    }
    return total;
  }

  stats() {
    let units = 0;
    let revenueCents = 0;
    for (const row of this.sales.values()) {
      units += row.qty;
      revenueCents += row.final_price_cents * row.qty;
    }
    return { accepted: this.sales.size, units, revenueCents };
  }

  reset() {
    this.sales.clear();
    this.outbox.clear();
    this.stock.clear();
  }
}

export function openStore() {
  if (DatabaseSync) {
    try {
      return new SqliteStore(defaultDbPath());
    } catch (err) {
      console.warn('[store] sqlite unavailable, falling back to memory:', err.message);
    }
  }
  return new MemoryStore();
}
