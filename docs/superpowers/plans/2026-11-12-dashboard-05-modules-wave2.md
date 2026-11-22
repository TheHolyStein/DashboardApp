# Dashboard 05 — Modules Wave 2 (House and Network)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the modules that watch and control the house: WLED master, Network monitor, NAS, Server health, Service pings, Quick links.

**Architecture:** One agent per module in `modules/<id>/`. Device access goes through `host.http` with `rule:'lanDevice'`; device addresses live in admin-only module config.

**Tech Stack:** as master plan; WLED adds `ws`; Network adds `net-snmp` only if a router adapter needs it.

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (sections 5.4, 6, 8.2)

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply. Every agent follows **Part 1 of plan 03 (Module playbook)** and the **Standard task cycle**.

## Review Focus

None owned beyond the generic suites. Extra care: these modules hold device credentials and can switch things on — every mutating route is `edit`, every device address is admin-configured.

**Shared rule for time series (network, nas, server-health, pings):** store in own table `m_<id>_samples(series, t, v)`; retention tiers: raw 24 h, 1-minute averages 30 days, 1-hour averages 365 days; a `compact` job (3600 s, always, module) rolls up and deletes; inserts are batched in one transaction per job run; history routes return at most 600 points (`from`, `to`, `series`), choosing the tier by range.

---

## Module: `wled` (branch `module/wled`)

**Manifest decisions:** scope `shared`; `multiInstance: true`; tile default 4×2, min 2×1, max 8×6; levels `['view','edit']`; jobs: `poll` (15 s, whenViewed, module), `presence` (120 s, always, module); publishes `device.offline`; subscribes `wled.apply.request`; outbound `[{kind:'lanDevice'}]`.

Module config (admin): `boards: Array<{ id: string; name: string; host: string; icon: string }>`, `groups: Array<{ id: string; name: string; icon: string; boardIds: string[] }>`, `presets: Array<{ id: string; name: string; state: { on?: boolean; bri?: number; color?: string; fx?: number; ps?: number } }>` (dashboard-level scenes applied to a target).
Instance settings: `targets: string[]` (board/group ids shown as buttons; empty = all groups then boards), `showBrightness: boolean`.

### Task L1: WLED client and state

**Files:** `manifest.ts`, `server/{wled-api.ts,state.ts,index.ts}`; fixtures `json-state.json`, `json-info.json`, `json-effects.json`, `json-palettes.json`, `presets.json`; Test `tests/api.test.ts`, `tests/server.test.ts`

```ts
export interface BoardState { id: string; name: string; online: boolean; on: boolean; bri: number; color: string /* #rrggbb of segment 0 */; fx: number; fxName: string; version: string | null }
export type Snapshot = { boards: BoardState[]; groups: Array<{ id: string; name: string; icon: string; on: 'all'|'some'|'none'; online: number; total: number }> };
export function toWledState(patch: { on?: boolean; bri?: number; color?: string; fx?: number; ps?: number }): object;   // WLED /json/state body
export async function apply(host: HostServices, target: string, patch): Promise<{ ok: string[]; failed: string[] }>;     // target = board id, group id, or 'all'
```
Rules: read `GET http://<host>/json/state` and `/json/info` (`timeoutMs: 2000`, no cache); write `POST /json/state`; a board failing 3 polls is `online:false` and publishes `device.offline` once (and a notification, level `warn`, `dedupeKey` per board); effects and palettes lists are cached per board for 24 h in `store`; `apply` fans out in parallel, never throws for a single failed board; `wled.apply.request`: `preset` resolves a dashboard preset by id or name (case-insensitive), `flash: true` sets white at full brightness for 2 s and then restores the previous state; unknown target/preset → warn log + notification to admins.

Routes: `GET /state` (view); `POST /apply` (edit) `{target, patch | presetId}`; `GET /boards/:id/effects` (view); `GET /boards/:id/presets` (view, the board's own presets); `POST /discover` (edit, admin only) → mDNS query `_wled._tcp` for 3 s via the netscan helper socket if present, else returns `[]` with `unavailable: true`.

**Tests:** `maps json-state fixture to BoardState`; `toWledState converts #ff8800 to seg col [[255,136,0]]`; `apply to group hits each member, reports partial failure`; `3 failed polls → offline + one device.offline`; `recovering board clears offline`; `wled.apply.request with preset name applies its state`; `flash restores previous state`; `non-admin discover → 403`; contract suites.

- [ ] Standard task cycle

### Task L2: Tile, detail, admin settings

**Files:** `client/{Tile,Detail,BoardCard,ColorWheel,EffectPicker,AdminSettings}.svelte`; Test `tests/client.test.ts`

Tile: one large toggle button per target with its configured icon, lit state (`all/some/none`), offline badge; optional brightness slider. Detail: per group and board — power, brightness, colour wheel, effect picker (searchable), board presets, dashboard presets; optimistic updates reconciled by the next snapshot; sliders debounce 150 ms. `Settings.svelte` (admin part) manages boards (add by address or from discovery), groups (name, icon, members), presets.

**Tests:** contract suites; `toggle sends apply and updates optimistically`; `offline board control disabled`; `view user sees state but no controls`; `slider debounced to one call`.

- [ ] Standard task cycle

---

## Module: `network` (branch `module/network`)

**Manifest decisions:** scope `shared`; `multiInstance: false`; tile default 4×2, min 2×1, max 8×6; levels `['view','edit']`; jobs: `probe` (10 s, always, module), `devices` (300 s, always, module), `speedtest` (21600 s, always, module — runs only if enabled), `compact`; publishes `net.connectivity.changed`, `net.device.unknown`; outbound hosts `1.1.1.1`, `9.9.9.9`, `speed.cloudflare.com` plus `{kind:'lanDevice'}` (router).

Module config: `gateway: string` (auto-detected default), `probeTargets: string[]` (default `['1.1.1.1','9.9.9.9']`), `dnsName: string` (default `example.com`), `speedtest: { enabled: boolean; maxMb: number }` (default off, 25), `knownDevices: Array<{ mac: string; name: string; icon: string }>`, `alertUnknown: boolean` (default true), `router: { kind: 'none'|'fritzbox'; host: string }`.

### Task M1: Probes and connectivity

**Files:** `manifest.ts`, `server/{probe.ts,connectivity.ts,samples.ts,index.ts}`; Test `tests/probe.test.ts`, `tests/connectivity.test.ts`, `tests/samples.test.ts`

```ts
export type Snapshot = { online: boolean; since: string; latencyMs: number | null; lossPct: number; down: number | null; up: number | null /* Mbit/s from interface counters */;
  spark: Array<[number, number]> /* latency, last 30 min, ≤ 60 pts */; devices: { known: number; unknown: number } };
export function decideOnline(history: boolean[]): boolean | 'unchanged';   // 3 consecutive failures → false; 2 consecutive successes → true
```
Rules: latency = HTTPS HEAD round-trip to each probe target through `host.http` (`timeoutMs: 3000`); gateway reachability and interface throughput are read locally (`/sys/class/net/<if>/statistics`, default-route interface) — no raw sockets in the main process; DNS time via `dns.promises.resolve`; `net.connectivity.changed` published only on a decided flip; series stored: `latency`, `loss`, `dns`, `rx`, `tx`, `gateway`; outage log in `m_network_outages(start, end)`; speed test downloads at most `maxMb` from `speed.cloudflare.com`, runs only when enabled, and lives in its own job so one slow run never delays probes.

Routes: `GET /history?series&from&to` (view); `GET /outages` (view); `POST /speedtest` (edit).

**Tests:** `3 failures flip offline once, 2 successes flip online once`; `single failure does not flip`; `throughput computed from two counter readings incl. counter wrap`; `samples compacted to 1-min after 24 h and 1-h after 30 d`; `history returns ≤ 600 points`; `outage row opened and closed`; contract suites.

- [ ] Standard task cycle

### Task M2: Device scan helper and unknown-device alerts

**Files:** `server/devices.ts`, `server/netscan-client.ts`, `deploy`-side helper source `modules/network/helper/netscan.ts` (built to a single file; installed by track E's unit); Test `tests/devices.test.ts`, `tests/netscan-protocol.test.ts`

Protocol (unix socket `/run/dashboard/netscan.sock`, newline-delimited JSON): request `{"op":"arp"}` → `{"devices":[{"ip","mac"}]}` (reads the kernel neighbour table and performs an ARP sweep of the local /24 at most once per 60 s); request `{"op":"mdns","service":"_wled._tcp","timeoutMs":3000}` → `{"hosts":[{"name","ip"}]}`. The helper accepts nothing else, validates `service` against `^_[a-z0-9-]+\._(tcp|udp)$`, caps `timeoutMs` at 5000, and never executes external programs.

Rules: devices keyed by MAC in `m_network_devices(mac, ip, first_seen, last_seen, vendor)`; vendor from a bundled OUI prefix list (top ~2000 prefixes, static file); a MAC not in `knownDevices` and first seen now → `net.device.unknown` + notification (level `warn`, `dedupeKey` per MAC) if `alertUnknown`; locally administered (randomised) MACs are flagged `random: true` and alert at most once per day in total; helper unavailable → devices section reports `unavailable`, no error.

Routes: `GET /devices` (view); `PUT /devices/:mac` (edit) `{name, icon}` → adds to known.

**Tests:** `new MAC publishes net.device.unknown once`; `known MAC never alerts`; `random MACs are throttled to one alert per day`; `helper missing → unavailable, job resolves`; `helper rejects invalid service string`; `helper rejects unknown op`.

- [ ] Standard task cycle

### Task M3: Tile and detail

**Files:** `client/{Tile,Detail,DeviceList,Outages}.svelte`; Test `tests/client.test.ts`

Tile: online/offline state, latency, down/up rates, latency sparkline, unknown-device badge. Detail: range picker (1 h / 24 h / 7 d / 30 d / 1 y), charts for latency + loss, throughput, DNS time; outage list with durations; device list (known/unknown, name it → known), speed test history and "run now" (`data-edit`).

**Tests:** contract suites; `offline state rendered with since time`; `naming a device calls PUT`; `range switch requests matching history`.

- [ ] Standard task cycle

---

## Module: `nas` (branch `module/nas`)

**Manifest decisions:** scope `shared`; `multiInstance: false`; tile default 3×2, min 2×1, max 6×6; levels `['view']`; jobs: `health` (300 s, always, module), `usage` (900 s, always, module), `compact`; publishes `nas.health.changed`, `todo.create.request`, `device.offline`; outbound `[{kind:'lanDevice'}]`.

Module config: `adapter: 'dsm'|'snmp'`, `host: string`, `port: number` (5001), `https: boolean` (true), `allowSelfSigned: boolean` (false; when true the certificate fingerprint is pinned on first contact and stored), `account: string`; secret `password` (DSM) or `community` (SNMP v2c) / v3 credentials; `createTodoOnFailure: boolean` (true).

### Task S1: Adapter interface, DSM adapter, health logic

**Files:** `manifest.ts`, `server/{adapter.ts,dsm.ts,health.ts,index.ts}`; fixtures `dsm-auth.json`, `dsm-storage.json`, `dsm-utilization.json`, `dsm-info.json` (recorded from the owner's NAS once its model is known; until then use published sample responses and mark `fixtures/README.md` "unverified against real device"); Test `tests/dsm.test.ts`, `tests/health.test.ts`

```ts
export interface NasReading { model: string; dsmVersion: string; uptimeSec: number; tempC: number | null;
  volumes: Array<{ id: string; name: string; status: 'normal'|'degraded'|'crashed'|'unknown'; usedBytes: number; totalBytes: number; raid: string }>;
  disks: Array<{ id: string; name: string; model: string; status: 'normal'|'warning'|'failing'|'failed'|'unknown'; smart: string; tempC: number | null; badSectors: number | null }> }
export interface NasAdapter { read(host: HostServices, cfg: Config): Promise<NasReading> }
export function overall(r: NasReading): { status: 'ok'|'degraded'|'failed'; detail: string };
export type Snapshot = { needsSetup?: true; online: boolean; status: 'ok'|'degraded'|'failed'; detail: string; usedPct: number; freeBytes: number; tempC: number | null; disks: Array<{ name: string; status: string }> };
```
Rules — DSM adapter: login through `SYNO.API.Auth` (session `sid` kept in memory, re-login on error code 119), read `SYNO.Storage.CGI.Storage` `load_info`, `SYNO.Core.System` `info`, `SYNO.Core.System.Utilization`; discover API paths/versions via `SYNO.API.Info` first (old DSM versions differ) and choose the highest supported version; the account must be read-only — README documents creating it. `overall`: any `crashed` volume or `failed` disk → `failed`; any `degraded` volume or `warning`/`failing` disk → `degraded`; else `ok`. On status change publish `nas.health.changed`, notify (critical for failed, warn for degraded, `dedupeKey: nas-health`); when a disk becomes `failing`/`failed` and `createTodoOnFailure`, publish `todo.create.request` (`sourceKey: nas:disk:<id>:replace`, list `deadline`, title `Replace NAS disk <name>`). Unreachable 3 times → `online:false`, `device.offline`. Series stored: `used:<volume>`, `temp:system`, `temp:<disk>`.

Routes: `GET /detail` (view) → full `NasReading` (no credentials); `GET /history?series&from&to` (view).

**Tests:** `dsm fixtures map to exact NasReading`; `error 119 triggers one re-login and retry`; `overall rules for each combination`; `status change publishes once, unchanged publishes nothing`; `failing disk creates todo request with stable sourceKey`; `missing config → needsSetup`; `password never appears in snapshot, detail, or logs` (suite case 9 + explicit log assertion); contract suites.

- [ ] Standard task cycle

### Task S2: SNMP adapter (fallback) and UI

**Files:** `server/snmp.ts`, `client/{Tile,Detail,DiskRow}.svelte`; Test `tests/snmp.test.ts`, `tests/client.test.ts`

Rules — SNMP adapter (Synology MIBs): system status `1.3.6.1.4.1.6574.1`, disks `…6574.2` (status, temperature, model), RAID `…6574.3`, plus host-resources storage table for usage; UDP 161 to the configured host only. Because `host.http` is HTTP-only, SNMP needs a contract change request adding `host.snmp.get/walk(hostRule 'lanDevice', oids)`; **file it at the start of this task**; until approved, implement the adapter against that proposed interface and keep it disabled. UI — tile: usage bar, health badge, temperature; detail: volumes with RAID type and usage history chart, disk table (status, SMART, temperature, bad sectors), system info.

**Tests:** `walk fixture maps to NasReading`; contract suites; `degraded badge uses warn colour token`; `needsSetup hint for admin vs member`.

- [ ] Standard task cycle

---

## Module: `server-health` (branch `module/server-health`)

**Manifest decisions:** scope `shared`; `multiInstance: false`; tile default 3×2, min 2×1, max 6×4; levels `['view']`; jobs: `sample` (30 s, whenViewed, module), `watch` (300 s, always, module), `compact`; outbound `[]`.

### Task H1: Whole module

**Files:** `manifest.ts`, `server/{read.ts,index.ts}`, `client/{Tile,Detail}.svelte`; Test `tests/read.test.ts`, `tests/server.test.ts`, `tests/client.test.ts`; fixtures: sample `/proc/stat`, `/proc/meminfo`, `/sys/class/thermal/*/temp`, `df` output

```ts
export type Snapshot = { cpuPct: number; memPct: number; tempC: number | null; diskPct: number; uptimeSec: number; load1: number; lastBackupAt: string | null; appRssMb: number };
export function cpuPct(prev: string, curr: string): number;          // from two /proc/stat readings
export function memPct(meminfo: string): number;                     // 1 − MemAvailable/MemTotal
```
Rules: read `/proc` and `/sys` with `fs` (paths injectable for tests); disk = filesystem of `DASH_DATA_DIR` via `fs.statfs`; `lastBackupAt` from newest file in `<dataDir>/backups`; `watch` job notifies (warn, deduped): disk > 85 %, temperature > 80 °C for 2 consecutive runs, memory > 90 % for 2 runs, backup older than 48 h (only once backups are configured); series `cpu`, `mem`, `temp`, `disk`. Detail: history charts for the four series, uptime, load, app memory, last backup time.

**Tests:** `cpuPct from two fixtures equals expected`; `memPct uses MemAvailable`; `missing thermal zone → tempC null`; `disk 86 % notifies once`; `temp must exceed twice before notifying`; contract suites.

- [ ] Standard task cycle

---

## Module: `pings` (branch `module/pings`)

**Manifest decisions:** scope `shared`; `multiInstance: true`; tile default 3×2, min 2×1, max 6×6; levels `['view']`; jobs: `check` (60 s, always, module), `compact`; publishes `device.offline`; outbound `[{kind:'lanDevice'},{kind:'publicUrl'}]`.

Module config: `targets: Array<{ id: string; name: string; url: string; kind: 'lan'|'public'; icon: string; expectStatus: number (default 200, 0 = any <500); alert: boolean }>` (≤ 30).
Instance settings: `targetIds: string[]` (empty = all).

### Task P1: Whole module

**Files:** `manifest.ts`, `server/{check.ts,index.ts}`, `client/{Tile,Detail}.svelte`; Test `tests/check.test.ts`, `tests/client.test.ts`

```ts
export type Snapshot = { targets: Array<{ id: string; name: string; icon: string; up: boolean | null; ms: number | null; since: string | null }> };
```
Rules: `GET` each target with `timeoutMs: 5000`, `maxBytes: 65536`, using the rule matching `kind`; up = status matches; down after 2 consecutive failures; on flip: notify if `alert` (warn; recovery as info) and publish `device.offline` when going down; series `ms:<id>`; uptime percentage over 24 h / 30 d computed from samples in the detail route `GET /detail?id`.

**Tests:** `2 failures flip down once`; `recovery notifies info`; `lan target with public address rejected by host (upstream) → shown as down, not crash`; `uptime pct computed`; contract suites.

- [ ] Standard task cycle

---

## Module: `links` (branch `module/links`)

**Manifest decisions:** scope `user`; `multiInstance: true`; tile default 3×2, min 1×1, max 12×4; levels `['view','edit']`; no jobs; outbound `[]`.

Instance settings: `links: Array<{ label: string; url: string; icon: string; newTab: boolean }>` (≤ 40), `layout: 'grid'|'list'`.

### Task Q1: Whole module

**Files:** `manifest.ts`, `server/index.ts`, `client/{Tile,Detail,Settings}.svelte`; Test `tests/client.test.ts`, `tests/server.test.ts`

Rules: no server state (links live in instance settings); URLs must be `http:`, `https:` or an in-app path starting with `/`; anything else (notably `javascript:`) is rejected by the settings schema; links render with `rel="noopener noreferrer"`; icons from theme icon keys or emoji; custom `Settings.svelte` with reorderable rows. Detail pane = same grid, larger, with search.

**Tests:** `schema rejects javascript: and data: URLs`; `external link has rel noopener noreferrer`; `grid collapses to icons only at 1×1`; contract suites.

- [ ] Standard task cycle
