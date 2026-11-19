# SnackBox — promo & sales sync demo (take-home, Task 4)

A small, runnable slice of the SnackBox design: **timed promos**, a **durable machine-side
outbox**, **idempotent sales ingest**, and (as a bonus) a **staged OTA rollout with a health
gate**.

One process, no dependencies: 20 simulated vending machines, a cloud API, and a dashboard.

- **Live demo:** https://snackbox-fleet-demo-173461988236.asia-southeast1.run.app — Google Cloud
  Run (project "My First Project", `project-5869a4b9-e007-42d4-b48`, `asia-southeast1`). The real
  server build: one Node process, `node:sqlite` (WAL) on disk, simulation and the dashboard in the
  page, `GET /api/state` live. Scales to zero when idle, so the first load can take a second or two.
  A static in-browser export (no server, in-memory store, clock advances only while a tab polls) is
  also hosted at https://zikazama.github.io/snackbox-fleet-demo/ as a fallback.
- **Local, one command:** `docker compose up --build`, or `npm start` / `make run` if you have
  Node 22.5+.

---

## What it shows

| Mechanic | Where to see it | Why it is the hard part |
| --- | --- | --- |
| **Timed promo distribution with config versions** | Create the 20%-off-drinks promo, hit `+15m` | A machine only changes price after it has *synced* the new config. Offline machines keep charging the old price — which is correct behaviour, not a bug. |
| **Durable local outbox + batched sync** | `Take 5 offline`, wait, `All online` | Sales are written to the machine's outbox first and deleted only after the cloud answers `200`. An offline machine keeps selling; the cloud's stock view visibly lags behind the machine's. |
| **Idempotent ingest (no double counting)** | Toggle `flaky 3G` | The cloud commits the batch and *then* drops the response. The machine retries the **same `event_id`s**, the cloud ignores them, and `duplicates blocked` climbs while revenue does not. |
| **Late / out-of-order sales** | Leave machines offline across a promo window | Events carry `sold_at` and `applied_promo_id`; the cloud accepts history instead of re-pricing it by arrival time. |
| **Rollout safety** | `inject bad build` + `Start rollout` | Canary cohort (10%) installs, fails health checks, the gate halts the rollout and rolls the cohort back. 18 of 20 machines never see the bad build. |

KPI strip: revenue, accepted events, duplicates blocked, unsynced events in outboxes, machines
online, current config version. The audit log shows each decision with the machine id, so a
reviewer can trace one event end to end.

## Guided walkthrough (60 seconds)

1. **Promo reaches only what is reachable.** `Create promo` (defaults: 20% off drinks, Fri
   15:00–17:00) → the config version bumps to v2. Online machines show `cfg v2` immediately;
   the three offline machines stay on `v1`. Hit `+15m`: synced machines drop prices, the audit
   log shows `CONFIG_SYNCED`.
2. **Offline is a normal state.** `Take 5 offline`, wait ~20 s, watch their `outbox` counters
   grow and `Unsynced events` climb while the cloud ledger stays flat. `All online` → queues
   drain in batches (`SALES_ACCEPTED ... N event(s)`), cloud stock catches up, the drift closes.
3. **Retries cannot double count.** Toggle `flaky 3G`. Batches commit, then ~50% of the
   responses are deliberately lost (`ACK_DROPPED`). Machines retry with exponential backoff;
   the cloud answers `DUPLICATE_IGNORED` for the same `event_id`s. `Revenue` and `Sales
   accepted` keep moving in step; `Duplicates blocked` is the evidence.
4. **Rollout safety.** Tick `inject bad build`, `Start rollout` (1.5.0). The canary installs,
   both machines fail health checks, the gate halts at 10% and rolls the cohort back —
   `OTA_HALTED ... 2/2 machines failed (100% > 10% gate)`, 18 machines still on 1.4.0. Untick
   the box, start again: the canary passes, then 40%, then the rest.

## How it runs

```
npm start                 # http://localhost:8080  (Node 22.5+, no install step)
make run                  # same thing
docker compose up --build # same thing, in a container
npm test                  # node --test, no dependencies
```

Open `http://localhost:8080` for the dashboard; it talks to the real HTTP API in that process.

On GitHub Pages (`https://zikazama.github.io/snackbox-fleet-demo/`) the page is served as static
files: `public/shim.js` intercepts `/api/*` and answers in-process via `public/engine.js`, a port
of `lib/world.js` + `lib/router.js` with the store always in memory. Append `?inprocess=1` to the
URL locally to force the same static path instead of the real server.

Environment variables (all optional):

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/snackbox.db` (`/tmp/snackbox.db` on Vercel) | SQLite file |
| `SIM_SPEED` | `120` | simulated seconds per real second |

## How it is built

```
cmd-less by design — one process, three layers
├── index.html           repo-root redirect to ./public/ (GitHub Pages entry point)
├── server.js            node:http entrypoint (local + Docker) + 250 ms sim ticker
├── api/index.js         Vercel serverless entrypoint, same router
├── netlify/functions/   Netlify serverless entrypoint, same router (v2 API)
├── lib/router.js        HTTP routes -> world actions
├── lib/world.js         cloud state + simulated fleet + promo pricing + OTA gate
├── lib/db.js            SQLite store (node:sqlite, WAL) with an in-memory fallback
├── public/index.html    dashboard, vanilla JS, polls /api/state every second
├── public/shim.js       static (Pages) build only: answers /api/* in-process
├── public/engine.js     static build only: port of world.js + router.js (browser)
└── test/core.test.js    pricing, idempotency, outbox, rollout gate
```

**The contract between machine and cloud** is small on purpose — this is the boundary the
design doc assumes, and the one a real agent would speak over HTTPS/MQTT. Both routes are
implemented and can be called with `curl`; the in-process simulator calls the same handler
directly (a self-HTTP hop would only add demo latency and say nothing new).

```
GET  /api/v1/config?machineId=SB-01   -> { version, catalog, promos, serverSimTime }
POST /api/v1/sales                    { machineId, events: [SaleEvent] }
                                      -> 200 { accepted: n, duplicates: n, revenueCents }
                                      -> 502 { committed: true }  (chaos: ACK dropped)
```

Demo control endpoints (the dashboard calls these): `POST /api/promos`,
`POST /api/promos/revoke`, `POST /api/machines/online`, `POST /api/fleet`,
`POST /api/chaos`, `POST /api/clock`, `POST /api/ota/start`, `POST /api/ota/abort`,
`POST /api/reset`, plus `GET /api/state`.

Key implementation decisions:

- **One transaction, one primary key.** `sales.event_id` is the idempotency key; the batch is
  applied inside `BEGIN IMMEDIATE`, and a duplicate insert is a no-op. This is deliberately the
  same mechanism I asked for in the PR review (unique constraint + single transaction, not
  "check then insert").
- **Delete from the outbox only after `200`.** The machine writes the sale locally *before* it
  attempts any network call, so a crash or a dead modem loses nothing.
- **Time is explicit.** The machines print prices from their own cached snapshot at the
  simulated instant, and events carry `sold_at`; nothing relies on server arrival order.
- **The OTA gate is a rate, not a case.** A cohort passes only if `failures / settled <= 10%`;
  the next cohort waits for the current one to finish health checks.

## What is faked

- The 20 machines are plain objects in the same process, not separate devices. There is no
  MQTT broker and no real modem.
- SQLite instead of Postgres + a cache. One node, no partitioning.
- The clock is a simulation (120× real time) with manual jumps, not wall-clock cron.
- No device identity: in production every machine would authenticate with its own mTLS
  certificate / signed request, and `machine_id` in the body would not be trusted.
- No auth on the control endpoints (it is a demo; anyone with the URL can push buttons).
- Sales are random, not a demand model; prices are synthetic `$`.
- State is in memory per serverless instance. On a free tier an instance is recycled now and
  then, and the demo re-seeds itself — that is also what `Reset demo` does.
- The public GitHub Pages build is **not a deployment of the server build**: there is no backend,
  no SQLite file, nothing survives a reload, and the clock only moves while a tab polls
  `/api/state`. It exists because free Docker/serverless hosts for this project all required a
  payment method or were otherwise unavailable (see Notes). `npm start` runs the real thing.

## What I would do next

1. **Device auth + transport.** mTLS per machine, signed batches (replay window), and an
   ingestion gateway that rejects `machine_id` spoofing. MQTT for the down-link, HTTPS for the
   up-link.
2. **Real persistence.** Postgres partitioned by `sold_at` month, `sales` insert-only, plus a
   read model for operator dashboards. The outbox becomes a proper RocksDB table on the device
   so it survives reboot and power loss.
3. **Delta sync instead of full snapshots.** Cursor-based config sync (`since=version`) so
   5,000 machines do not each pull the whole catalog on every change.
4. **Promo correctness under clock skew.** Device clock drift bounded by NTP, promo windows
   evaluated in a single fleet timezone, and an explicit "promo grace window" so a machine that
   was offline when a promo ended does not sell at the old price forever.
5. **OTA as a real pipeline.** Signed firmware, A/B partitions with automatic rollback on failed
   boot, staged cohorts by region, and a hard rule that no rollout exceeds X% of the fleet per
   hour. The health gate here is the toy version of that.
6. **Observability.** `duplicate_events_total`, `outbox_depth`, `machine_offline_seconds`,
   `ingest_lag_seconds` as first-class metrics — the demo shows the numbers a real dashboard
   would need.

## Deployment

- **Google Cloud Run (primary live URL):** deployed from source with `gcloud run deploy
  snackbox-fleet-demo --source . --region asia-southeast1` (Cloud Build builds the `Dockerfile`).
  Allows unauthenticated access; memory 512 Mi. Redeploy after pushing changes with the same
  command.
- **Local / Docker (real build):** same artifact as the live Cloud Run service. SQLite on disk, the
  simulator and the API in one Node process.
- **GitHub Pages (fallback):** static export of the same logic — `public/index.html` identical to
  the local dashboard, with `public/shim.js` answering `/api/*` in-process from `public/engine.js`.
- **Serverless entrypoints kept for reference:** `api/index.js` (Vercel), `netlify/functions/api.mjs`.
  Neither was deployable with the accounts available: GCP `impactful-web-512106-c6` is shut down
  and the `fauzi.fadman@gmail.com` account has no billing account; the Vercel team is blocked by
  fair-use limits; Render requires a card even for the free plan; the Netlify GitHub authorization
  failed with `You can't perform that action at this time`; Hugging Face Docker Spaces need a paid
  plan here. If any of those unblocks, the entrypoints are ready — and the local build is the
  intended way to see it run anyway.

## Notes

- Written in Node rather than Go: the machine I built this on had no Go toolchain and no Docker
  daemon, and the demo had to be *deployed and openable*, which mattered more than the language.
  The design doc and the production plan are Go; the HTTP contract above is what a Go service
  would implement, and the concurrency-critical part (one transaction + unique key) is the same
  regardless of language.
- Amounts are synthetic. The fleet is 20 machines so the dashboard stays readable; the loop is
  the same at 5,000.
