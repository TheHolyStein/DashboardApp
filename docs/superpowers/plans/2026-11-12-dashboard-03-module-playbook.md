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

**Contract v2 helpers** (use these instead of rolling your own; details in `docs/contract-changes/002-v2-from-clock.md`):
- `newId(host.now())` from `@dash/module-kit`: uuid v7, time-ordered. No `crypto.randomUUID()` for ids.
  `newId()` ids are time-ordered between milliseconds but not within one; order by `created_at`, not by id.
- `createSnapshotPusher(host)` from `@dash/module-kit`: `push(instanceId | null, data)` sends only when the JSON changed (returns `false` otherwise); `forget(id)` on instance removal. Create it in `setup` (below); never in module-level state.
  Snapshot pusher compares JSON text — build snapshot objects with a stable key order.
- `setup(host)` / `teardown(host)` on `ModuleServer` (both optional): the loader calls `setup` once per loaded, enabled module after migrations and before the first job, route or event handler; a throw marks the module failed. `teardown` runs on server shutdown before the database closes. **Keep per-host state (snapshot pusher, caches) in a closure created in `setup`; never at module scope** (see the template's `createServer()`). In tests use `createMockHostWithSetup(server, { prepare? })` from `@dash/module-kit/testing`; the server contract suite calls `setup` before running jobs.
- `locale` and `timeZone` props on `TileProps`, `DetailProps` and `SettingsProps` are the signed-in user's saved preferences. Pass them to every `Intl.*` / `toLocale*String` call (`new Intl.DateTimeFormat(locale, { timeZone, … })`); never use the browser's or server's default. The client suite renders with `de-DE` and `Asia/Kolkata`.
- Typed route bodies: `r.post('/x', { level: 'edit', body: Schema }, (req) => … req.body …)` gives `req.body` as `z.infer<typeof Schema>` (same for `query`). Handlers may return a value, a promise, or `undefined` (204). No re-parsing, no casts, no `Promise.resolve` wrapper.
- `applyMigrations` (mock host) runs every statement of a migration like the real runner: put a table and its index in one migration.
- Notification text keys: `host.notify({ level, title, body, titleKey: 'm.<id>.notify.x', bodyKey?, vars?: { label } })`. `title`/`body` stay the English fallback (also what Web Push shows); the dashboard renders `t(titleKey, title, vars)`.
- Detail pane: the shell opens it when the tile frame or the tile title (a button) is activated, except for clicks on links, buttons, inputs or `[data-no-open]` elements, and not in edit mode. Do not add your own overlay button. Set `detail: false` in `defineClient({ … })` for a tile without a detail view; `openDetail(params)` still works for deep links from inside the tile.
- Context keys and the theme seam: import `THEME_CONTEXT_KEY`, `T_CONTEXT_KEY`, `ICONS_CONTEXT_KEY` and the `ThemeSeam` type from `@dash/contract`; no string literals or local copies.
- `@dash/ui` extras: `<Button busy={…}>` (disabled, `aria-busy`, same size) and `serial(fn)` (calls run one after another, each returns its own promise) for handlers that read-modify-write a list, so updates are not lost.
- `@dash/ui` brings its own type declarations: no `env.d.ts` declaration for the uPlot stylesheet in your module.
- `no-unused-vars` is the typescript-eslint rule in `.svelte` files: parameter names in function types are fine; no disable comments needed.

**More rules of thumb (v2):**
- **Formatted values are data:** render formatted numbers, times and dates as `<span data-value>{formatted}</span>`. The client contract suite exempts text inside `[data-value]` from the "goes through `t()`" check; do not wrap them in placeholder `t('m.x.value', '{value}', …)` calls. Words still go through `t()`; text without the attribute fails the suite. `data-value` text that reads as a sentence still fails.
- **User content is exempt:** wrap text the user typed or a feed delivered (titles, labels, headlines) in `<span data-user>…</span>`. The client suite skips it for both the `t()` rule and the `data-value` prose guard. `data-value` = formatted values, `data-user` = user content.
- **Important values must be readable text** (or the tile is unreadable to a screen reader): an image-like rendering (SVG gauge, canvas, clock face) needs `role="img"` and an `aria-label` that contains the value. The theme suite checks this for clock faces (hour and minute in visible text or in the `aria-label`).
- **Stale:** the tile frame (`@dash/ui` `Tile`) already shows the stale badge from `stale`. Do not re-implement a marker, and do not invent progress from stale data: a countdown keeps counting, with the frame's badge showing that the data is old.
- **`per: 'module'` jobs** get `instance: null`; wrap every awaited host call in `abortable(ctx.signal, …)`, including `host.instances()`, `host.users()` and `host.store.*`, so the job stops when it is aborted.
- **Shared pages:** snapshots of an instance on a shared page are visible to every viewer of the page. Put only what the owner is willing to show everyone into a snapshot, and never secrets (see the template README).
- **Ordering:** put a per-owner `rev` in snapshots and mutation responses; clients apply only newer data. Raise `rev` (an integer kept in the `setup` closure, persisted in `host.store` so it survives restarts) in the same synchronous step as every change to that owner's data, stamp every snapshot and every `GET`/`POST`/`DELETE` list response with it, and have the client keep `{ rev, data }` as its single source of truth and apply an incoming list only when its `rev` is greater than or equal to the held one. Do not re-fetch after a push to "settle" a race: overlapping fetches are not ordered either. Show an error line when a fetch fails.
- **Clock: copy this, not that.** Copy: per-host state in a closure created in `setup` with a `need()` accessor. Do not copy: the `hasNext`/sequence-counter machinery (a workaround for the store lacking a prefix-exists query), the client `console.warn`, a module-level formatter cache, and e2e assertions tied to the fallback clock readout.
- **Svelte boundaries do not catch async errors.** A rejected promise inside an event handler or `$effect` is yours to catch: `try/catch` around `await api…` and show an error state with `t()`.
- **Secrets in generated settings forms:** a stored secret is not cleared by leaving the field empty. Offer an explicit remove/reset action (a route that calls `host.secrets.delete`) if clearing must be possible.

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
