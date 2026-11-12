# Dashboard 03 — Reference Slice (Clock) and Module Playbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the contracts end to end with one real module (Clock) running on the Futro, and fix the recipe every later module agent follows.

**Architecture:** Clock is the smallest module that still touches tile, detail, settings, a theme-provided component (clock face), own data (timers), events, and a route. Whatever hurts while building it is fixed in the contract before fan-out.

**Tech Stack:** as master plan.

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (sections 5.3, 8.1)

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply.

## Review Focus

None owned here beyond the generic suites; this plan's job is to surface contract gaps.

**Execution:** serial, one agent, branch `module/clock`, then device deployment with the human.

---

## Part 1 — Module playbook (every module agent follows this)

**Inputs you get:** the spec, the master plan, this playbook, and your module's brief (plans 04–06). You work only in `modules/<id>/`.

**Folder (created by `pnpm new:module <id>`):**
```
modules/<id>/
  package.json            @dash/module-<id>
  manifest.ts             defineManifest(...)                    ← decisions from your brief
  server/index.ts         defineServer({ manifest, migrations, jobs, routes, on })
  server/*.ts             pure logic in small files (parsers, mappers, repos)
  client/index.ts         defineClient({ manifest, Tile, Detail, Settings? })
  client/Tile.svelte      essentials only; must work at tile.min size
  client/Detail.svelte    everything else
  fixtures/               recorded upstream responses + tile.json + detail.json
  tests/server.test.ts    runServerContractSuite + your logic tests
  tests/client.test.ts    runClientContractSuite + your component tests
  README.md               what it shows, config keys, data source, limits
```

**Order of work:**
1. `pnpm new:module <id>`; fill `manifest.ts` from the brief. Run the contract suite — the manifest cases must pass before anything else.
2. Record fixtures: save real upstream responses once (by hand or a throwaway script outside the repo), strip personal data and keys, commit under `fixtures/`. Tests use only these.
3. Pure logic first, test-first: parsers and mappers from fixture → your snapshot type. No host needed.
4. Jobs: fetch through `host.http`, map, `host.push`, publish events. Test with `createMockHost`.
5. Routes with levels. Test with `createMockRouter`.
6. `Tile.svelte`, then `Detail.svelte`, from `fixtures/tile.json` / `detail.json`, using only `@dash/ui` primitives and `--db-*` tokens.
7. Run both contract suites, `pnpm --filter @dash/module-<id> test`, then `pnpm check`.
8. Manual look: `pnpm dev`, place the tile, check day/night, min and max size, phone width, stale state (stop the network), view-only user.
9. Write `README.md`. Final report per the master plan's definition of done.

**Rules of thumb:**
- **Snapshot = what the tile needs, nothing more.** Keep it under 20 KB. History and lists are fetched by the detail pane through routes.
- **Export your snapshot and settings types** from `manifest.ts` (`export type Snapshot = …`) so theme authors can write tile overrides.
- **Upstream failure:** throw `DashError('upstream', …)` and keep the last snapshot; never push partial or empty data over good data.
- **First run:** a job must work with empty storage and missing config. Missing required config → push `{ needsSetup: true }` and return; the tile shows "Open settings to set up" for admins and "Not set up yet" for others.
- **Styling:** no colours, fonts, radii or shadows outside tokens. No fixed pixel widths. Use container queries on the tile for small/large layouts.
- **Text:** every string through `t('m.<id>.<key>', 'English fallback')`.
- **Editing controls** carry `data-edit` and are not rendered when `level === 'view'`.
- **Time:** `host.now()` on the server; `now` passed down or `$state` ticking on the client. Format with `Intl` using the user's locale and time zone.
- **Events instead of imports:** to make something happen in another module, publish a `*.request` event; to react, subscribe. If the event you need is missing, file a contract change request.
- **Units of work in the detail pane that need charts** use `<Chart>` from `@dash/ui`; never import uPlot directly.

**Standard tests every module adds beyond the suites:**
- mapper test per fixture (`maps <fixture> to snapshot` with exact expected values);
- one test per route for the happy path and one for its main failure;
- one test per event published (payload values) and per event handled;
- tile test for its "needs setup" state.

---

## Part 2 — Clock module

### Task K1: Manifest and logic

**Files:** Create `modules/clock/manifest.ts`, `modules/clock/server/timers.ts`; Test `modules/clock/tests/server.test.ts`

**Interfaces — Produces:**
```ts
export const settings = z.object({
  face: z.string().default('').meta({ label: 'Clock face', help: 'Empty = theme default' }),
  timeZone: z.string().default('').meta({ label: 'Time zone', widget: 'timezone', help: 'Empty = your time zone' }),
  label: z.string().max(40).default(''),
  showSeconds: z.boolean().default(false),
  hour12: z.boolean().default(false),
  showDate: z.boolean().default(true),
  showNextEvent: z.boolean().default(true),
});
export type Settings = z.infer<typeof settings>;
export type Snapshot = { timers: Array<{ id: string; label: string; endsAt: string; durationSec: number }>;
                         nextEvent: { title: string; start: string } | null };
// manifest: id 'clock', scope 'user', multiInstance true, tile default 3×2 min 2×1 max 6×4, levels ['view','edit'],
// jobs [{ name:'tick', intervalSec:5, mode:'always', per:'module' }],
// publishes ['timer.finished'], subscribes ['calendar.event.upcoming'], outbound []
```
Table `m_clock_timers(id, owner_id, label, ends_at, duration_sec, fired)`.

```ts
export function createTimer(db: ModuleDb, ownerId: UserId, input: { label: string; durationSec: number }, now: Date): Timer;   // 1 ≤ durationSec ≤ 86400, label ≤ 40
export function dueTimers(db: ModuleDb, now: Date): Timer[];          // ends_at ≤ now and fired = 0
export function markFired(db: ModuleDb, id: string): void;
```

**Tests:** contract suite; `createTimer rejects 0 and 86401`; `dueTimers returns only unfired past timers`; `tick publishes timer.finished once per timer and notifies its owner` (run the job twice, expect one event); `calendar.event.upcoming stores nextEvent per user and pushes it only to that user's instances`.

- [ ] Standard task cycle

### Task K2: Routes

**Files:** Create `modules/clock/server/index.ts`

Routes: `GET /timers` (view) → own timers; `POST /timers` (edit) `{label, durationSec}`; `DELETE /timers/:id` (edit, owner only → else 404).

**Tests:** `POST creates and pushes updated snapshot`; `DELETE of another user's timer → 404`; `view level POST → 403` (suite covers; assert explicitly once).

- [ ] Standard task cycle

### Task K3: Tile, detail, clock faces

**Files:** Create `modules/clock/client/{index.ts,Tile.svelte,Detail.svelte,useNow.svelte.ts}`, `modules/clock/fixtures/{tile.json,detail.json}`; Test `modules/clock/tests/client.test.ts`

Rules: the tile renders the theme's clock face (`face` setting or theme default) through a `clockFace` prop source — the shell provides it via Svelte context key `dash:theme` (`getContext('dash:theme').clockFace(id)`); below the face: date (if `showDate`), next event countdown (if `showNextEvent` and present), running timers (max 2, "+n"). `useNow` ticks every second only when `showSeconds`, else on the minute boundary; it pauses while the document is hidden. Detail: world clocks (list of time zones stored in instance settings is out of scope — use a local list in `store` via `GET/PUT /zones`, edit level), timer create/cancel, stopwatch (client-only).

Add routes `GET /zones` (view), `PUT /zones` (edit, ≤ 12 IANA zones validated with `Intl.supportedValuesOf('timeZone')`).

**Tests:** contract suite; `tile shows countdown "in 25 min" for nextEvent 25 minutes ahead`; `useNow does not tick per second when showSeconds is false`; `invalid zone rejected with 422`; `unknown face id falls back to theme default`.

- [ ] Standard task cycle

### Task K4: End-to-end and device deployment (Gate G3)

**Files:** Create `e2e/clock.spec.ts`; Modify `docs/ops/setup-guide.md` with anything learned

- [ ] `e2e/clock.spec.ts`: sign in → edit mode → add Clock → tile visible → open settings → enable seconds → seconds visible → click tile → pane opens → create 3-second timer → notification badge increments within 5 s → Escape closes pane.
- [ ] With the human: install Debian on the Futro, follow `docs/ops/setup-guide.md` literally, run `deploy/install.sh`. Record every deviation in the guide.
- [ ] From a phone on mobile data with Tailscale on: open the dashboard, install as app, add Clock.
- [ ] On the Futro: `deploy/doctor.sh` all OK; `systemd-analyze security dashboard.service` ≤ 2.5; RSS < 200 MB; idle CPU < 2 % over 5 minutes (`pidstat 60 5`). Record numbers in `docs/ops/baseline.md`.
- [ ] Reboot the Futro; the dashboard is back without manual action.
- [ ] Collect contract pain points into `docs/contract-changes/`; orchestrator applies them; tag `contract-v2` if anything changed; update `tools/templates/module`.
- [ ] Commit, merge, tag `v0.1.0`.
