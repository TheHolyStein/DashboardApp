# Dashboard 08 — Cross-Cutting Features

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the features that span modules: built-in links between modules, CalDAV phone sync, the app launcher (Skills App placeholder), Web Push, and backups.

**Architecture:** Five independent features, each on its own branch with an explicit list of paths it may touch. Links are core subscribers on the event bus. CalDAV lives inside the calendar module behind its allow-listed root mount. The launcher is a core feature that controls systemd units through a narrow, fixed command set.

**Tech Stack:** as master plan; CalDAV adds `fast-xml-parser`; Web Push adds `web-push`; launcher uses `systemctl` via a root-owned polkit rule or sudoers entry limited to named units.

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (sections 5.4, 5.8, 6, 8.5, 9)

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply. Each task follows the **Standard task cycle**.

## Review Focus

Owned here: master Review Focus #3 for the CalDAV path (Task D3).

**Parallelism:** X (Links), D (CalDAV), A (Launcher), P (Push), B (Backups) are independent of each other. Prerequisites: X needs the modules it connects; D needs Calendar (plan 04); P needs Notifications (plan 04); A and B need only plan 03.

---

## Feature X — Built-in links (`feature/links`)

**May touch:** `apps/server/src/core/links/**`, `apps/server/test/core/links/**`, `apps/web/src/shell/settings/Links.svelte`

### Task X1: Link framework and settings

**Files:** `src/core/links/index.ts`, `src/core/links/registry.ts`, `apps/web/src/shell/settings/Links.svelte`; Test `test/core/links/registry.test.ts`

```ts
export interface Link { id: string; name: string; description: string; needs: ModuleId[]; defaultOn: boolean;
  options?: z.ZodObject; on: { [E in EventName]?: (payload: EventPayload<E>, ctx: LinkContext) => void | Promise<void> } }
export interface LinkContext { publish<E extends EventName>(name: E, payload: EventPayload<E>): void; notify(n: Notification & { moduleId: ModuleId }): void;
  options: unknown; state: { get<T>(k: string): T | undefined; set(k: string, v: unknown): void }; now(): Date }
export function registerLinks(bus: Bus, links: Link[], deps): void;
```
Rules: a link is active only if enabled (admin setting, stored in `kv` under module id `core-links`) and every module in `needs` is installed and enabled; links publish as `core`; a throwing link is logged and disabled until restart after 5 consecutive errors; settings page lists links with toggle, description and generated options form; routes `GET/PUT /api/admin/links` (admin).

**Tests:** `disabled link receives nothing`; `link with missing needed module is inactive and shown as unavailable`; `5 errors disable the link and notify admins`; `options validated`.

- [ ] Standard task cycle

### Task X2: The links

**Files:** one file per link under `src/core/links/`; Test one test file per link

| id | needs | on → does | options (defaults) |
|---|---|---|---|
| `sun-theme` | weather | `time.sun` → stores latest as core snapshot `core:sun` for clients' `sun` mode policy | — |
| `calendar-wled` | calendar, wled | `calendar.event.started` with tag `wake` → `wled.apply.request {target, preset}` | target `all`, preset `Wake` |
| `outdoor-weather` | calendar, weather | `calendar.day.summary` and `weather.updated` → for each of today's events tagged `outdoor`: if the latest weather has `nextPrecip` before the event ends or `pollenMax ≥ pollenLevel`: notify that user once per event | pollenLevel `4` |
| `timer-wled` | clock or focus, wled | `timer.finished` → `wled.apply.request {target, flash:true}` | target `all` |
| `focus-wled` | focus, wled | `focus.phase` → preset per phase | work `Focus`, break `Break`, idle `` (none) |
| `air-wled` | wled | `air.threshold` → colour by level (`ok` restore, `warn` `#ffb000`, `crit` `#ff2000`) on target | target `` (off until set) |
| `air-notify` | — | `air.threshold` `warn`/`crit` → notify all ("Ventilate: <metric> <value>"), deduped per sensor+level per hour | — |
| `offline-quiet` | network | `net.connectivity.changed {online:false}` → sets core flag `core:offline`; the snapshot stale computation treats modules with any non-LAN outbound rule as "offline since <time>" instead of failed; back online → clears flag and asks the scheduler to re-run overdue jobs spread over 60 s | — |
| `device-offline-notify` | — | `device.offline` → notify admins (warn, deduped per device per 6 h) | — |
| `moon-calendar` | moon, calendar | `moon.updated` when phase name becomes `full` or `new` → `pin.request` for that date ("Full moon") | onlyFull `true` |
| `chores-calendar` | todo, calendar | handled inside the calendar UI as a virtual read-only calendar fed by `todo.day.summary`; the link only toggles `kv` flag `calendar:showChores` | — |

**Tests (one per link, exact):** e.g. `calendar-wled publishes wled.apply.request with configured preset when started event has tag wake, nothing otherwise`; `outdoor-weather notifies once per event, not again on later weather updates`; `air-wled restores previous state request on ok`; `offline-quiet sets and clears flag and triggers spread re-run`; `timer-wled ignores timers when wled disabled` (inactive via `needs`).

- [ ] Standard task cycle

---

## Feature D — CalDAV (`feature/caldav`)

**May touch:** `modules/calendar/server/caldav/**`, `modules/calendar/tests/caldav/**`, `modules/calendar/server/index.ts` (mount only), `docs/ops/calendar-sync.md`

Target clients: Apple Calendar (iOS/macOS), DAVx⁵ (Android), Thunderbird. Scope: events only (no tasks, no scheduling/invitations, no free-busy).

URL layout: `/.well-known/caldav` → 301 `/dav/`; principal `/dav/principals/<handle>/`; calendar home `/dav/calendars/<handle>/`; collection `/dav/calendars/<handle>/<calendarId>/`; resource `…/<uid>.ics`. Shared calendars appear in each permitted user's home. Auth: HTTP Basic with an app password (`verifyAppPassword`); no session cookies; no CSRF.

### Task D1: XML layer, discovery, PROPFIND

**Files:** `caldav/xml.ts`, `caldav/props.ts`, `caldav/propfind.ts`, `caldav/router.ts`; fixtures `tests/caldav/fixtures/*.xml` (recorded requests of the three clients for discovery); Test `tests/caldav/propfind.test.ts`

```ts
export function handleDav(req: { method: string; path: string; headers: Record<string,string>; rawBody: Buffer; user: SessionUser }, deps): Promise<RawResponse>;
```
Rules: `OPTIONS` → `DAV: 1, 3, calendar-access` and `Allow`; `PROPFIND` with `Depth: 0|1` (reject `infinity` with 403); properties supported: `current-user-principal`, `principal-URL`, `calendar-home-set`, `resourcetype`, `displayname`, `calendar-color` (Apple namespace), `supported-calendar-component-set` (VEVENT), `getctag` (CalendarServer namespace) and `sync-token` (both derived from `sync_seq`), `getetag`, `getcontenttype`, `current-user-privilege-set` (read; plus write when calendar access ≥ edit and module level edit), `owner`; unknown properties → 404 propstat; XML parsed with entity expansion disabled, body ≤ 1 MB; all responses `207 Multi-Status` with correct namespaces.

**Tests:** `each recorded client discovery sequence yields principal → home → calendar list`; `Depth infinity → 403`; `read-only share reports no write privilege`; `stranger's calendar path → 404 (not 403, no existence leak)`; `entity-bomb body rejected`; `missing/invalid Basic → 401 with WWW-Authenticate`.

- [ ] Standard task cycle

### Task D2: REPORTs and sync

**Files:** `caldav/report.ts`, `caldav/sync.ts`; Test `tests/caldav/report.test.ts`, `tests/caldav/sync.test.ts`

Rules: `calendar-multiget` (hrefs → etag + calendar-data); `calendar-query` with a VEVENT `time-range` filter (other filters: return all VEVENTs, clients filter locally) — recurring events included when any occurrence intersects the range; `sync-collection` (RFC 6578): token `…/sync/<seq>`; returns changed hrefs since the token from `m_calendar_changes`, deleted ones as 404 entries, new token; an unknown/too-old token → `403` with `valid-sync-token` precondition so the client resyncs; changes log trimmed to 10 000 rows per calendar (older tokens become invalid); private events (`#private`) are omitted for everyone but their creator.

**Tests:** `multiget returns requested resources with etags`; `time-range returns a weekly event whose 5th occurrence is in range`; `sync from token N returns exactly the changes after N including deletions`; `invalid token → valid-sync-token error`; `other user's private event absent from every report`.

- [ ] Standard task cycle

### Task D3: GET, PUT, DELETE with preconditions

**Files:** `caldav/resource.ts`; Test `tests/caldav/resource.test.ts`, `tests/caldav/conflict.test.ts`

Rules: `GET` returns the stored ICS byte-for-byte with `ETag`; `PUT` with `If-None-Match: *` creates (412 if exists), with `If-Match: <etag>` updates (412 on mismatch), without either: create or overwrite only if the resource does not exist, else 412; body must be one VCALENDAR with VEVENTs sharing one UID equal to the path's uid, ≤ 256 KB, else 403 with `valid-calendar-data` / `valid-calendar-object-resource`; `DELETE` honours `If-Match`; writes go through the same `upsertEvent`/`deleteEvent` as the web API (so `calendar.event.changed`, change log, and command `reconcile` all run); read-only calendars and view-level users → 403; subscription calendars are read-only.

**Tests:** `conflict.test`: `PUT with stale If-Match → 412 and stored event unchanged`; `web API edit then CalDAV PUT with old etag → 412`; `CalDAV edit then web PUT with old etag → 409`; `If-None-Match:* on existing → 412`. Others: `GET returns identical bytes to what was PUT`; `UID mismatch with path → 403`; `event created from phone with "@dani !remind 30m" in the title produces the todo request and reminder`; `PUT to read-only share → 403`.

- [ ] Standard task cycle

### Task D4: Client verification and guide

**Files:** `docs/ops/calendar-sync.md`, `modules/calendar/tests/caldav/clients.md` (manual checklist with results)

- [ ] With the human, on real devices against the Futro: add the account in iOS Calendar, DAVx⁵, Thunderbird using the tailnet URL and an app password.
- [ ] For each client: discover calendars; create, edit, move, delete a single event both directions; create a weekly event and edit one occurrence and "this and future"; an all-day event; a time-zone event; an event with `@handle`; confirm a read-only share cannot be edited; confirm sync after the phone was offline for a day.
- [ ] Record every deviation as a failing test from a captured request, fix, re-run.
- [ ] Write the guide with screenshots-free step lists per client.

---

## Feature A — App launcher (`feature/launcher`)

**May touch:** `apps/server/src/core/launcher/**`, `apps/server/test/core/launcher/**`, `apps/web/src/shell/Launcher.svelte`, `config/launcher.example.yaml`, `deploy/launcher/**`, `docs/ops/launcher.md`

### Task A1: Config and unit generation (server side, root tooling)

**Files:** `config/launcher.example.yaml`, `deploy/launcher/gen-units.sh`, `deploy/launcher/dashboard-app@.service.tmpl`, `deploy/launcher/90-dashboard-launcher.rules` (polkit), `deploy/launcher/caddy-apps.tmpl`; Test `deploy/test/launcher.bats`

```yaml
# /etc/dashboard/launcher.yaml — edited over SSH only; root:dashboard 0640
apps:
  - id: skills                 # ^[a-z][a-z0-9-]{1,31}$
    name: Skills App
    icon: launch
    workdir: /opt/skills-app   # TODO: fill in
    start: npm run start       # TODO: fill in; run via /bin/sh -c as user below
    stop: ""                   # empty = SIGTERM to the unit
    port: 3000                 # must listen on 127.0.0.1
    health: /                  # path polled on 127.0.0.1:<port>
    startTimeoutSec: 90
    user: skills               # dedicated system user, created by gen-units.sh
    memoryMax: 1G
    cpuQuota: 150%
    minimalMode: true          # pause non-critical dashboard jobs while running
    stripPrefix: true          # proxy /apps/skills/* → / on the app
    allowedUsers: []           # empty = admins only; else user names
```
Rules: `install.sh` calls `gen-units.sh`, which validates the YAML, creates each `user`, writes `dashboard-app-<id>.service` (the command comes from the root-owned file; hardened: `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=<workdir>`, `PrivateTmp`, `MemoryMax`, `CPUQuota`, `Restart=no`), a Caddy snippet proxying `/apps/<id>/*` to `127.0.0.1:<port>` (prefix stripped when `stripPrefix`), and a polkit rule allowing the `dashboard` user to `start`/`stop` exactly the units named `dashboard-app-<id>.service` and nothing else. Changing `launcher.yaml` requires re-running `install.sh`. The shipped example has the Skills App entry commented out.

**Tests (bats):** `valid yaml generates unit with expected ExecStart, User, MemoryMax`; `id with slash rejected`; `port < 1024 rejected`; `polkit rule names only the generated units`; `re-run with removed app deletes its unit and snippet`.

- [ ] Standard task cycle

### Task A2: Launcher service and API

**Files:** `src/core/launcher/config.ts`, `src/core/launcher/service.ts`, `src/core/launcher/routes.ts`; Test `test/core/launcher/service.test.ts`

```ts
export type AppState = 'stopped'|'starting'|'running'|'stopping'|'failed';
export interface Systemctl { start(unit: string): Promise<void>; stop(unit: string): Promise<void>; isActive(unit: string): Promise<'active'|'inactive'|'failed'|'activating'|'deactivating'> }
export function createLauncher(deps: { config: LauncherConfig; systemctl: Systemctl; probe: (port: number, path: string) => Promise<boolean>; scheduler: Scheduler; audit; now }): Launcher;
export interface Launcher { list(user: SessionUser): AppView[]; start(id: string, user: SessionUser): Promise<void>; stop(id: string, user: SessionUser): Promise<void> }
```
Rules: the server reads `launcher.yaml` (read-only) only for id, name, icon, port, health, timeout, minimalMode, allowedUsers — it never reads or executes `start`/`stop` strings; `Systemctl` runs `systemctl start|stop|is-active dashboard-app-<id>.service` with `execFile` (no shell) where `<id>` is checked against the loaded config ids; start: `setMinimal(true)` if configured → start unit → poll health every 1 s until `startTimeoutSec` → `running`, else stop the unit, `failed`, `setMinimal(false)`, notify the user; stop or unit death (checked every 15 s) → `setMinimal(false)` once no minimal-mode app is running; state changes are sent to permitted users over the stream as a core snapshot `core:launcher`; every start/stop is audited. Routes: `GET /api/launcher` (session), `POST /api/launcher/:id/start|stop` (session + allowed).

**Tests:** `unknown id → 404 and systemctl never called`; `start reaches running when probe succeeds`; `timeout → failed, unit stopped, minimal mode restored`; `minimal mode stays on while a second minimal app is running`; `non-allowed member → 403`; `unit dying externally is noticed and minimal mode restored`; `systemctl invoked with execFile args, id not interpolated into a shell`.

- [ ] Standard task cycle

### Task A3: Launcher UI and switching

**Files:** `apps/web/src/shell/Launcher.svelte`; Test `apps/web/test/shell/launcher.test.ts`; `docs/ops/launcher.md`

Rules: top-bar launcher menu lists apps with state; "Start" shows progress with elapsed time and, when `minimalMode`, a note that the dashboard is in minimal mode; when `running`: "Open" navigates to `/apps/<id>/` in the same tab; apps are separate pages, so the way back is a small floating "⌂ Dashboard" button injected by Caddy for HTML responses under `/apps/*` (a fixed snippet via `templates`/`replace` in `caddy-apps.tmpl`; if the app's CSP blocks it, the docs describe the browser Back button and the PWA shortcut instead); the dashboard remembers the last page and returns to it; "Stop" asks for confirmation. `docs/ops/launcher.md`: how to fill in the Skills App entry, requirements for an app (must listen on localhost, must work under a path prefix or with `stripPrefix`), troubleshooting.

**Tests:** `start shows starting then Open`; `failed shows error and retry`; `member without permission does not see the app`.

- [ ] Standard task cycle

---

## Feature P — Web Push (`feature/push`)

**May touch:** `apps/server/src/core/push/**`, `apps/server/test/core/push/**`, `apps/web/src/lib/push.ts`, `apps/web/src/shell/settings/Push.svelte`, `apps/web/src/sw-push.ts`

### Task P1: Subscriptions and delivery

**Files:** `src/core/push/{vapid.ts,subscriptions.ts,sink.ts,routes.ts}`; Test `test/core/push/sink.test.ts`

Rules: VAPID key pair generated once and stored through core secrets; table `push_subscriptions(id, user_id, endpoint UNIQUE, p256dh, auth, ua, created_at, last_ok_at, failures)` (orchestrator adds to core schema); routes `GET /api/push/key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe` (session); the sink registered with `registerNotificationSink` sends when: level ≥ the user's chosen minimum (default `warn`), module not muted, and the user has no live stream connection that is currently visible (avoid double alerts); payload = `{title, body, url, tag: dedupeKey}` only — no sensitive detail beyond what the notification already shows; endpoint host must be one of the known push services (`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`), else rejected at subscribe; 404/410 from the push service deletes the subscription; 5 consecutive failures delete it; push needs internet — while `core:offline` is set, sends are skipped, not queued.

**Tests:** `info-level notification not pushed at default minimum`; `muted module not pushed`; `visible live client suppresses push`; `410 removes subscription`; `subscribe with unknown endpoint host → 422`; `offline flag skips send`.

- [ ] Standard task cycle

### Task P2: Client

**Files:** `apps/web/src/lib/push.ts`, `src/shell/settings/Push.svelte`, `src/sw-push.ts`; Test `apps/web/test/shell/push.test.ts`

Rules: settings toggle "Notifications on this device" (requests permission only on user click), minimum level picker, per-device list with remove; on iOS explain that the dashboard must be installed to the home screen first (detect standalone mode); service worker shows the notification and on click focuses an existing window or opens `url`.

**Tests:** `permission requested only after click`; `denied permission shows explanation`; `notification click focuses existing client`.

- [ ] Standard task cycle

---

## Feature B — Backups (`feature/backups`)

**May touch:** `deploy/backup/**`, `deploy/systemd/dashboard-backup.{service,timer}`, `apps/server/src/core/backup-cli.ts`, `docs/ops/backup-restore.md`

### Task B1: Backup, off-box copy, restore

**Files:** `apps/server/src/core/backup-cli.ts`, `deploy/backup/backup.sh`, `deploy/backup/restore.sh`, `deploy/systemd/dashboard-backup.service`, `.timer`; Test `apps/server/test/core/backup.test.ts`, `deploy/test/backup.bats`

Rules: nightly at 03:30 (+ random 15 min): `backup-cli` uses the SQLite online backup API to write `backups/dash-<UTC timestamp>.sqlite`, runs `PRAGMA integrity_check` on the copy, then `zstd`-compresses; module blobs directory is added as a tar; local retention: 7 daily, 4 weekly; if `/etc/dashboard/backup.env` defines a target, the archive is encrypted with `age` to the configured public key and copied — targets: `rsync` over SSH to the NAS (key-based, dedicated restricted NAS user) or a mounted path; remote retention 30 days; failures notify admins (critical) through `backup-cli notify` (writes a notification row directly); `secret.key` is **not** included in backups — the guide tells the owner to store it separately (password manager) and explains that secrets cannot be restored without it. `restore.sh <file>`: stops the service, verifies and decrypts, keeps the current database as `pre-restore-<ts>`, replaces, runs migrations, starts, health-checks.

**Tests:** `backup of a database under concurrent writes passes integrity_check`; `retention keeps 7 daily + 4 weekly`; `corrupt backup is detected and reported, old backups untouched`; bats: `restore round-trips a database and keeps pre-restore copy`; `backup without target config succeeds locally`; `archive does not contain secret.key`.

- [ ] Standard task cycle

### Task B2: Restore drill

- [ ] With the human on the Futro: run a backup, copy to the NAS, wipe `/var/lib/dashboard` on a scratch copy (or a VM), restore from the NAS copy using only `docs/ops/backup-restore.md`. Fix the guide where it was unclear. Record the date in `docs/ops/baseline.md`.
