// The whole demo world: cloud state + simulated fleet, in one process.
//
// Time is a controllable simulation clock (SIM_SPEED = 120x). The world is
// advanced lazily by `advance()` on every request, so it works identically on a
// long-running process and on a serverless function that only wakes up when
// somebody looks at the dashboard.
//
// Three mechanics worth reading:
//   1. Config versioning   - the cloud bumps configVersion; a machine only sees a
//                            new price/promo snapshot after it syncs.
//   2. Durable outbox      - a sale is written to the machine's local outbox
//                            first, and deleted only after the cloud answers 200.
//   3. Idempotent ingest   - UNIQUE(sales.event_id) inside one transaction, so a
//                            retried batch never double counts.

import { randomUUID } from 'node:crypto';
import { openStore } from './db.js';

export const SIM_SPEED = Number(process.env.SIM_SPEED) > 0 ? Number(process.env.SIM_SPEED) : 120; // 1 real second = N simulated seconds
const STEP_MS = 60_000; // simulate in one-minute ticks
const MAX_STEPS_PER_CALL = 5_000;
const TZ_MS = 8 * 3_600_000; // display in UTC+8 (Southeast Asia)
const BASE_SIM = Date.UTC(2026, 10, 20, 6, 40, 0); // Friday 14:40 UTC+8
const MACHINE_COUNT = 20;
const SALE_PROB_PER_MIN = 0.06; // per machine, tuned so the dashboard moves
const FLAP_PROB_PER_MIN = 0.0008; // modem randomly drops / recovers
const MAX_BATCH = 50; // machine flushes at most 50 events per request
const LATENESS_MS = 4 * 3_600_000; // "late" = sold more than 4 simulated hours ago

export const CATALOG = [
  { sku: 'COLA-330', name: 'Cola 330ml', category: 'drinks', listPriceCents: 350 },
  { sku: 'WATER-600', name: 'Mineral Water 600ml', category: 'drinks', listPriceCents: 200 },
  { sku: 'COFFEE-RTD', name: 'Iced Coffee 240ml', category: 'drinks', listPriceCents: 500 },
  { sku: 'CHIPS-120', name: 'Potato Chips 120g', category: 'snacks', listPriceCents: 400 },
  { sku: 'BAR-CHOC', name: 'Chocolate Bar 55g', category: 'snacks', listPriceCents: 300 },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FLEET_FW = '1.4.0';

export function simLabel(ms) {
  const d = new Date(ms + TZ_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = DAY_NAMES[d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${dd} ${hh}:${mm}`;
}

export function money(cents) {
  return `${(cents / 100).toFixed(2)}`;
}

/**
 * Price a SKU against a config snapshot at a given simulated instant.
 * The machine uses its *own* snapshot, which is why an offline machine keeps
 * charging yesterday's price until it syncs.
 */
export function priceFor(snapshot, sku, atSimMs) {
  const item = snapshot.catalog.find((c) => c.sku === sku);
  if (!item) return { price: 0, promo: null };
  const local = new Date(atSimMs + TZ_MS);
  const day = local.getUTCDay();
  const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  let best = { price: item.listPriceCents, promo: null };
  for (const p of snapshot.promos) {
    if (p.revoked) continue;
    if (!p.days.includes(day)) continue;
    if (minuteOfDay < p.startMin || minuteOfDay >= p.endMin) continue;
    if (p.sku && p.sku !== sku) continue;
    if (p.category !== 'all' && p.category !== item.category) continue;
    const discounted = Math.max(0, item.listPriceCents - Math.round((item.listPriceCents * p.discountPct) / 100));
    if (discounted < best.price) best = { price: discounted, promo: p };
  }
  return best;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class World {
  constructor() {
    this.store = openStore();
    this.reset({ silent: true });
  }

  // ---------------------------------------------------------------- lifecycle

  reset({ silent = false } = {}) {
    this.store.reset();
    const now = Date.now();
    this.lastReal = now;
    this.simMs = BASE_SIM;
    this.nextStepSim = this.simMs + STEP_MS;
    this.bootedAt = now;
    this.configVersion = 1;
    this.promos = [];
    this.promoSeg = 0;
    this.catalog = structuredClone(CATALOG);
    this.snapshot = this._buildSnapshot();
    this.audit = [];
    this.auditSeq = 0;
    this.counters = { duplicatesBlocked: 0, ackDrops: 0, commits: 0, lateAccepted: 0 };
    this.chaos = { ackDrop: false };
    this.ota = this._freshOta();
    this.machines = [];

    for (let i = 1; i <= MACHINE_COUNT; i++) {
      const id = `SB-${String(i).padStart(2, '0')}`;
      const stock = {};
      for (const c of this.catalog) stock[c.sku] = 14 + Math.floor(Math.random() * 16);
      this.machines.push({
        id,
        online: true,
        snapshot: this.snapshot,
        configVersion: 1,
        stock,
        attempt: 0,
        nextAttemptAt: 0,
        lastSaleSim: null,
        lastSettledSim: null,
        fw: FLEET_FW,
        prevFw: FLEET_FW,
        fwTarget: null,
        fwProgress: 0,
        fwNeeded: 0,
        health: 'ok',
        healthCheckAt: 0,
        faulted: false,
        restockAt: 0,
        sales: 0,
      });
    }
    // Matches the brief: roughly 15% of the fleet is offline at any moment.
    for (const id of ['SB-04', 'SB-11', 'SB-17']) {
      const m = this.byId(id);
      m.online = false;
      m.offlineSinceSim = this.simMs;
    }
    this.store.seedMachines(this.machines.map((m) => ({ id: m.id, stock: m.stock })));
    if (!silent) {
      this.log('warn', 'DEMO_RESET', null, 'fleet re-seeded, cloud ledger cleared');
    }
    this.log('ok', 'CLOUD_READY', null, `${this.machines.length} machines registered, config v${this.configVersion}`);
  }

  _freshOta() {
    return {
      state: 'idle', // idle | rolling | halted | done
      fromVersion: FLEET_FW,
      version: '1.5.0',
      badFirmware: false,
      cohortIndex: 0,
      cohorts: [],
      steps: [],
      gatePct: 10,
      nextCohortAtSim: 0,
      haltedReason: null,
      startedAtSim: null,
    };
  }

  byId(id) {
    return this.machines.find((m) => m.id === id);
  }

  log(kind, label, machineId, detail) {
    this.audit.unshift({
      id: ++this.auditSeq,
      at: simLabel(this.simMs),
      kind,
      label,
      machine: machineId,
      detail,
    });
    if (this.audit.length > 240) this.audit.length = 240;
  }

  // -------------------------------------------------------------------- clock

  /** Advance simulated time to `realNow`. Safe to call from every request. */
  advance(realNow = Date.now()) {
    if (this._advancing) return this.simMs;
    this._advancing = true;
    try {
      // Cap the catch-up window: a slept container should resume, not replay hours.
      const elapsed = Math.min(Math.max(realNow - this.lastReal, 0), 60_000);
      this.lastReal = realNow;
      if (elapsed <= 0) return this.simMs;
      this.simMs += elapsed * SIM_SPEED;
      let steps = 0;
      while (this.simMs >= this.nextStepSim && steps < MAX_STEPS_PER_CALL) {
        this._step(this.nextStepSim);
        this.nextStepSim += STEP_MS;
        steps += 1;
      }
      this._flushAll(realNow);
    } finally {
      this._advancing = false;
    }
    return this.simMs;
  }

  jump(minutes) {
    const target = this.simMs + minutes * 60_000;
    let steps = 0;
    while (this.simMs < target && steps < MAX_STEPS_PER_CALL) {
      this.simMs = Math.min(target, this.simMs + STEP_MS);
      this._step(this.simMs);
      steps += 1;
    }
    this.nextStepSim = this.simMs + STEP_MS;
    this._flushAll(Date.now());
    this.log('sync', 'CLOCK_JUMP', null, `+${minutes} min -> ${simLabel(this.simMs)}`);
  }

  _step(atSim) {
    for (const m of this.machines) {
      if (m.faulted) continue;

      // Flaky cellular modem: random drops and recoveries.
      if (m.online && Math.random() < FLAP_PROB_PER_MIN) this.setOnline(m.id, false, 'modem dropped');
      else if (!m.online && Math.random() < FLAP_PROB_PER_MIN * 2) this.setOnline(m.id, true, 'modem back');

      this._otaStep(m, atSim);
      // A vending machine sells whether or not its modem works. Only the flush
      // needs connectivity - that is exactly what the outbox is for.
      this._maybeSell(m, atSim);
      this._maybeRestock(m, atSim);
    }
    if (this.ota.state === 'rolling') this._evaluateOta(atSim);
  }

  // ------------------------------------------------------------------- sales

  _maybeSell(m, atSim) {
    if (Math.random() >= SALE_PROB_PER_MIN) return;
    const inStock = this.catalog.filter((c) => (m.stock[c.sku] || 0) > 0);
    if (!inStock.length) return;
    const item = pick(inStock);
    const { price, promo } = priceFor(m.snapshot, item.sku, atSim);
    const ev = {
      event_id: randomUUID(),
      machine_id: m.id,
      sku: item.sku,
      qty: 1,
      list_price_cents: item.listPriceCents,
      final_price_cents: price,
      discount_cents: item.listPriceCents - price,
      sold_at: atSim,
      config_version: m.snapshot.version,
      applied_promo_id: promo ? promo.id : null,
    };
    m.stock[item.sku] -= 1;
    m.lastSaleSim = atSim;
    m.sales += 1;
    // 1) durable local write first, 2) the sale exists even if the modem dies now.
    this.store.enqueue(m.id, ev);
  }

  _maybeRestock(m, atSim) {
    const total = Object.values(m.stock).reduce((a, b) => a + b, 0);
    if (total > 6) return;
    if (!m.restockAt) {
      m.restockAt = atSim + 6 * 3_600_000;
      this.log('warn', 'STOCK_LOW', m.id, 'empty, technician dispatched');
      return;
    }
    if (atSim >= m.restockAt && m.online) {
      for (const c of this.catalog) m.stock[c.sku] = 12 + Math.floor(Math.random() * 18);
      this.store.seedMachines([{ id: m.id, stock: m.stock }]);
      m.restockAt = 0;
      this.log('ok', 'RESTOCKED', m.id, 'technician refilled the machine');
    }
  }

  // -------------------------------------------------------------------- sync

  _flushAll(realNow) {
    for (const m of this.machines) {
      if (!m.online || m.faulted) continue;
      this._syncConfig(m);
      this._flushSales(m, realNow);
    }
  }

  _syncConfig(m) {
    if (m.configVersion === this.configVersion) return;
    const from = m.configVersion;
    m.snapshot = this.snapshot;
    m.configVersion = this.configVersion;
    this.log('sync', 'CONFIG_SYNCED', m.id, `v${from} -> v${m.configVersion}`);
  }

  _flushSales(m, realNow) {
    if (realNow < m.nextAttemptAt) return;
    const batch = this.store.pending(m.id, MAX_BATCH);
    if (!batch.length) return;
    const late = batch.filter((e) => this.simMs - e.sold_at > LATENESS_MS).length;
    try {
      const result = this._ingest(m.id, batch);
      this.store.ack(m.id, batch.map((e) => e.event_id));
      m.attempt = 0;
      m.nextAttemptAt = 0;
      if (result.accepted > 0) {
        this.log(
          'ok',
          'SALES_ACCEPTED',
          m.id,
          `${result.accepted} event(s), ${money(result.revenueCents)} revenue` +
            (late ? ` · ${late} sold before reconnect` : '')
        );
        if (late) {
          this.counters.lateAccepted += late;
          this.log('ok', 'LATE_SALE_ACCEPTED', m.id, `${late} event(s) kept their original sold_at and promo`);
        }
      }
      if (result.duplicates > 0) {
        this.counters.duplicatesBlocked += result.duplicates;
        this.log('dup', 'DUPLICATE_IGNORED', m.id, `${result.duplicates} event_id(s) already committed, nothing counted twice`);
      }
    } catch (err) {
      m.attempt += 1;
      const backoff = Math.min(8_000, 400 * 2 ** Math.min(m.attempt, 5)) * (0.7 + Math.random() * 0.6);
      m.nextAttemptAt = realNow + backoff;
      if (m.attempt <= 2) {
        this.log('err', 'ACK_LOST', m.id, `${err.message} - keeping ${batch.length} event(s), retry in ${Math.round(backoff)}ms`);
      }
    }
  }

  /**
   * The cloud endpoint. Commits first, then (when chaos is on) loses the response,
   * which is exactly the failure mode that makes naive ingestion double count.
   */
  _ingest(machineId, events) {
    const result = this.store.applyBatch(events);
    this.counters.commits += 1;
    if (this.chaos.ackDrop && Math.random() < 0.5) {
      this.counters.ackDrops += 1;
      this.log('err', 'ACK_DROPPED', machineId, `committed ${result.accepted} event(s) then dropped the response`);
      const err = new Error('network: response lost after commit');
      err.status = 502;
      throw err;
    }
    return result;
  }

  // ---------------------------------------------------------------- mutations

  setOnline(id, online, reason = 'manual') {
    const m = this.byId(id);
    if (!m) return null;
    if (m.online === online) return m;
    m.online = online;
    if (online) {
      m.faulted = false;
      m.health = m.health === 'failed' ? 'ok' : m.health;
      m.nextAttemptAt = 0;
      const pending = this.store.outboxCounts()[m.id] || 0;
      this.log('sync', 'MACHINE_ONLINE', m.id, reason + (pending ? `, ${pending} queued sale(s) to flush` : ''));
    } else {
      m.offlineSinceSim = this.simMs;
      this.log('warn', 'MACHINE_OFFLINE', m.id, reason);
    }
    return m;
  }

  createPromo({ category = 'all', discountPct = 20, startMin = 900, endMin = 1020, days = [5], label }) {
    const promo = {
      id: `PR-${++this.promoSeg}`,
      label:
        label ||
        `${discountPct}% off ${category === 'all' ? 'everything' : category} · ${days.map((d) => DAY_NAMES[d]).join(',')} ${fmtMin(startMin)}-${fmtMin(endMin)}`,
      category,
      discountPct,
      startMin,
      endMin,
      days,
      createdAtSim: this.simMs,
      revoked: false,
    };
    this.promos.push(promo);
    this._bumpConfig('PROMO_CREATED', `promo ${promo.id} ${promo.label}`);
    return promo;
  }

  revokePromo(id) {
    const promo = this.promos.find((p) => p.id === id);
    if (!promo) return false;
    promo.revoked = true;
    this._bumpConfig('PROMO_REVOKED', `promo ${id} revoked`);
    return true;
  }

  _buildSnapshot() {
    return {
      version: this.configVersion,
      catalog: this.catalog.map((c) => ({ ...c })),
      promos: this.promos.filter((p) => !p.revoked).map((p) => ({ ...p })),
    };
  }

  _bumpConfig(label, detail) {
    this.configVersion += 1;
    this.snapshot = this._buildSnapshot();
    this.log('sync', label, null, `${detail} -> config v${this.configVersion}`);
  }

  // --------------------------------------------------------------------- OTA

  startOta({ version, badFirmware = false } = {}) {
    const ids = this.machines.map((m) => m.id);
    const canary = ids.slice(0, Math.max(1, Math.round(ids.length * 0.1)));
    const half = ids.slice(canary.length, canary.length + Math.round(ids.length * 0.4));
    const rest = ids.slice(canary.length + half.length);
    this.ota = {
      ...this._freshOta(),
      state: 'rolling',
      version: version || '1.5.0',
      fromVersion: this.machines[0].fw,
      badFirmware,
      startedAtSim: this.simMs,
      cohorts: [canary, half, rest],
      steps: [
        { label: 'Canary 10%', size: canary.length, status: 'installing', failRate: null },
        { label: '40% of fleet', size: half.length, status: 'pending', failRate: null },
        { label: 'Rest of fleet', size: rest.length, status: 'pending', failRate: null },
      ],
    };
    this._assignCohort(0);
    this.log('sync', 'OTA_STARTED', null, `firmware ${this.ota.version} staged, canary ${canary.length} machine(s)` + (badFirmware ? ' · BAD BUILD INJECTED' : ''));
  }

  _assignCohort(index) {
    const ids = this.ota.cohorts[index];
    for (const id of ids) {
      const m = this.byId(id);
      m.prevFw = m.fw;
      m.fwTarget = this.ota.version;
      m.fwProgress = 0;
      m.fwNeeded = 20; // 20 simulated minutes to download + flash + reboot
      m.health = 'ok';
    }
    this.ota.cohortIndex = index;
    this.ota.steps[index].status = 'installing';
  }

  _otaStep(m, atSim) {
    if (m.faulted) return;
    if (m.fwTarget && m.fw !== m.fwTarget) {
      if (!m.online) return; // cannot install over a dead modem
      m.fwProgress += 1;
      if (m.fwProgress >= m.fwNeeded) {
        m.fw = m.fwTarget;
        m.health = 'pending';
        m.healthCheckAt = atSim + 5 * 60_000;
        this.log('sync', 'OTA_INSTALLED', m.id, `now on ${m.fw}, awaiting health checks`);
      }
      return;
    }
    if (m.health === 'pending' && atSim >= m.healthCheckAt) {
      if (!m.online && atSim < m.healthCheckAt + 60 * 60_000) return; // wait for the machine to call home
      const failProb = this.ota.badFirmware ? 0.75 : 0.02;
      if (Math.random() < failProb) {
        m.health = 'failed';
        m.faulted = true;
        m.online = false;
        this.log('err', 'HEALTH_FAILED', m.id, `boot loop on ${m.fw} - pulled from service`);
      } else {
        m.health = 'ok';
        this.log('ok', 'HEALTH_OK', m.id, `${m.fw} passed health checks`);
      }
    }
  }

  _evaluateOta(atSim) {
    if (this.ota.nextCohortAtSim) {
      if (atSim < this.ota.nextCohortAtSim) return;
      // Cool-down finished: stage the next cohort.
      this.ota.nextCohortAtSim = 0;
      this._assignCohort(this.ota.cohortIndex);
      return;
    }

    const idx = this.ota.cohortIndex;
    const machines = this.ota.cohorts[idx].map((id) => this.byId(id));
    const settled = machines.filter((m) => (m.fw === this.ota.version && m.health !== 'pending') || m.faulted);
    if (settled.length < machines.length) return;

    const failed = settled.filter((m) => m.health === 'failed').length;
    const rate = settled.length ? (failed / settled.length) * 100 : 0;
    this.ota.steps[idx].failRate = Math.round(rate * 10) / 10;

    if (rate > this.ota.gatePct) {
      this.ota.steps[idx].status = 'halted';
      this.ota.state = 'halted';
      this.ota.haltedReason = `${failed}/${settled.length} machines failed health checks (${this.ota.steps[idx].failRate}% > ${this.ota.gatePct}% gate)`;
      for (const m of machines) {
        if (m.health === 'failed') continue; // bricked machines stay offline, but only these
        if (m.fw === this.ota.version) {
          m.fw = m.prevFw;
          m.fwTarget = null;
          m.fwProgress = 0;
          m.health = 'ok';
        }
      }
      const untouched = this.machines.filter((m) => m.fw === this.ota.fromVersion && !this.ota.cohorts[idx].includes(m.id)).length;
      this.log('err', 'OTA_HALTED', null, `${this.ota.haltedReason}; cohort rolled back, ${untouched} machine(s) never touched`);
      return;
    }

    this.ota.steps[idx].status = 'passed';
    this.log('ok', 'OTA_COHORT_PASSED', null, `${this.ota.steps[idx].label}: ${settled.length} healthy, 0 rollbacks`);
    if (idx + 1 < this.ota.cohorts.length) {
      this.ota.nextCohortAtSim = atSim + 10 * 60_000;
      this.ota.cohortIndex = idx + 1;
      this.ota.steps[idx + 1].status = 'waiting';
    } else {
      this.ota.state = 'done';
      this.log('ok', 'OTA_DONE', null, `fleet on ${this.ota.version}`);
    }
  }

  abortOta() {
    if (this.ota.state === 'idle') return false;
    for (const m of this.machines) {
      if (m.faulted) continue;
      if (m.fw === this.ota.version) {
        m.fw = m.prevFw;
        m.health = 'ok';
      }
      m.fwTarget = null;
      m.fwProgress = 0;
    }
    this.ota.state = 'halted';
    this.ota.haltedReason = 'aborted by operator';
    this.log('warn', 'OTA_ABORTED', null, 'rollout stopped, installed machines rolled back');
    return true;
  }

  // ---------------------------------------------------------------- read view

  state() {
    const counts = this.store.outboxCounts();
    const cloud = this.store.cloudStock();
    const stats = this.store.stats();

    const machines = this.machines.map((m) => {
      const localUnits = Object.values(m.stock).reduce((a, b) => a + b, 0);
      return {
        id: m.id,
        online: m.online,
        faulted: m.faulted,
        configVersion: m.configVersion,
        stock: m.stock,
        localUnits,
        cloudUnits: cloud[m.id] ?? 0,
        outbox: counts[m.id] || 0,
        attempt: m.attempt,
        fw: m.fw,
        fwTarget: m.fwTarget,
        installPct: m.fwTarget && m.fw !== m.fwTarget ? Math.round((m.fwProgress / m.fwNeeded) * 100) : m.fw === this.ota.version ? 100 : 0,
        health: m.health,
        sales: m.sales,
        lastSale: m.lastSaleSim ? simLabel(m.lastSaleSim) : null,
        lowStock: localUnits <= 6,
      };
    });

    const online = machines.filter((m) => m.online).length;
    const unsynced = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      sim: { nowMs: this.simMs, label: simLabel(this.simMs), speed: SIM_SPEED, day: new Date(this.simMs + TZ_MS).getUTCDay() },
      kpi: {
        revenueCents: stats.revenueCents,
        salesAccepted: stats.accepted,
        unitsSold: stats.units,
        duplicatesBlocked: this.counters.duplicatesBlocked,
        ackDrops: this.counters.ackDrops,
        unsynced,
        online,
        offline: machines.length - online,
        configVersion: this.configVersion,
        lowStock: machines.filter((m) => m.lowStock).length,
        faulted: machines.filter((m) => m.faulted).length,
        lateAccepted: this.counters.lateAccepted,
      },
      machines,
      promos: this.snapshot.promos,
      catalog: this.catalog,
      ota: {
        ...this.ota,
        cohorts: this.ota.cohorts,
        activeIds: this.ota.cohorts[this.ota.cohortIndex] || [],
      },
      chaos: this.chaos,
      audit: this.audit.slice(0, 60),
      storage: this.store.kind,
    };
  }
}

function fmtMin(min) {
  const h = String(Math.floor(min / 60) % 24).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export const world = new World();
