# Dashboard 02 — Core Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build everything a module or theme needs to run: server core and host services, sign-in and permissions, the web shell, the theme engine with a Default theme, and deployment to the Futro.

**Architecture:** Five tracks built in parallel against the frozen contract from plan 01. Tracks meet only at interfaces defined in `@dash/contract` and in the "Seams" section below; each track stubs the others' seams in its tests.

**Tech Stack:** Fastify 5, better-sqlite3, Drizzle, `@node-rs/argon2`, `otpauth`, Svelte 5, Vite, gridstack, uPlot, Workbox, Caddy, systemd.

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (sections 5, 6, 7, 9)

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply.

## Review Focus

Owned here: master Review Focus #2 (A5), #4 (A1), #5 (A4, C2).

Every task follows the **Standard task cycle** from the master plan. Each task below lists files, interfaces and the tests that define done.

## Seams between tracks

```ts
// apps/server/src/seams.ts — created by the orchestrator before fan-out, edited by no track
export interface AuthSeam {                                   // implemented by track B, consumed by A
  plugin: FastifyPluginAsync;                                 // decorates request.user (or null); handles /api/auth/*, /api/me, /api/admin/users, /api/admin/grants
  requireUser(req: FastifyRequest): SessionUser;              // throws DashError('unauthenticated')
  levelFor(userId: UserId, moduleId: ModuleId): PermissionLevel;
  verifyAppPassword(basicAuthHeader: string | undefined): SessionUser | null;
  onGrantsChanged(cb: (userId: UserId, moduleId: ModuleId, level: PermissionLevel) => void): void;
  listUsers(): Array<{ id: UserId; name: string; handle: string; role: 'admin'|'member' }>;
}
export interface SessionUser { id: UserId; name: string; handle: string; role: 'admin'|'member' }
export interface CoreSeam {                                   // implemented by track A, consumed by B
  db: BetterSqlite3.Database;                                 // core tables via Drizzle
  audit(entry: { userId: UserId | null; action: string; detail?: object; ip?: string }): void;
  config: AppConfig;
}
export interface AppConfig { dataDir: string; configDir: string; host: '127.0.0.1'; port: number; baseUrl: string; secretKeyFile: string; env: 'development'|'production'|'test' }
```

Environment variables (track A reads, track E sets): `DASH_DATA_DIR` (default `./.data`, prod `/var/lib/dashboard`), `DASH_CONFIG_DIR` (prod `/etc/dashboard`), `DASH_PORT` (`8787`), `DASH_BASE_URL`, `DASH_SECRET_KEY_FILE` (prod `/etc/dashboard/secret.key`, 32 random bytes), `NODE_ENV`.

Core tables (track A owns the Drizzle schema file `apps/server/src/core/schema.ts`; track B adds its tables in `apps/server/src/auth/schema.ts`):

| Table | Columns | Owner |
|---|---|---|
| `users` | id, name (unique), handle (unique), role, password_hash, totp_secret_enc, prefs json, disabled, created_at | B |
| `sessions` | id_hash, user_id, csrf, created_at, last_seen_at, expires_at, ua, ip | B |
| `app_passwords` | id, user_id, label, hash, scope (`caldav`), created_at, last_used_at | B |
| `grants` | user_id, module_id, level | B |
| `login_attempts` | key, count, window_start, locked_until | B |
| `audit_log` | id, at, user_id, action, detail json, ip | A |
| `pages` | id, owner_id, name, icon, sort, shared, background | A |
| `instances` | id, module_id, page_id, settings json, x, y, w, h, mobile_order | A |
| `snapshots` | module_id, instance_id (nullable), data json, updated_at, job_ok | A |
| `kv` | module_id, key, value json | A |
| `secrets` | module_id, name, nonce, ciphertext | A |
| `module_state` | module_id, enabled, config json, migration_id | A |
| `job_state` | module_id, job, instance_id, last_run_at, last_ok_at, failures, next_run_at | A |
| `notifications` | id, module_id, user_id, level, title, body, url, dedupe_key, created_at, read_at | A |
| `http_cache` | key, status, headers json, body blob, expires_at, etag | A |

---

## Track A — Server core (`track/server-core`)

### Task A1: Database, migrations, crash safety

**Files:** Create `apps/server/package.json` (`@dash/server`), `src/core/db.ts`, `src/core/schema.ts`, `src/core/migrate.ts`, `drizzle/**`; Test `test/core/db.test.ts`, `test/core/db.crash.test.ts`

**Interfaces — Produces:**
```ts
export function openDb(file: string): BetterSqlite3.Database;   // pragmas: journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000
export function migrateCore(db): void;                           // Drizzle migrations, idempotent
export function migrateModule(db, moduleId: ModuleId, migrations: Migration[]): void;  // tracks module_state.migration_id; each migration in a transaction; rejects SQL touching tables without the module prefix
export function backupTo(db, destFile: string): Promise<void>;   // SQLite online backup API
```

**Tests:**
- `migrateCore twice is a no-op`
- `migrateModule applies only new ids, in order`
- `migrateModule rejects 'CREATE TABLE users2' with DashError('invalid')`
- `failed migration rolls back and leaves migration_id unchanged`
- `db.crash.test.ts` → `database survives SIGKILL during writes`: spawn a child process that inserts rows in a loop inside transactions, `SIGKILL` it after 300 ms, reopen: `PRAGMA integrity_check` returns `ok`, and row count equals the last committed transaction count the child reported on stdout.

- [ ] Standard task cycle

### Task A2: Config, app bootstrap, health, error mapping, security headers

**Files:** Create `src/core/config.ts`, `src/core/app.ts`, `src/main.ts`, `src/core/errors.ts`, `src/core/static.ts`; Test `test/core/app.test.ts`

**Interfaces — Produces:**
```ts
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig;            // throws listing every invalid variable
export async function buildApp(deps: { config: AppConfig; db; auth: AuthSeam; modules: ModuleServer[] }): Promise<FastifyInstance>;
```
`buildApp` registers: JSON body limit 1 MB; error handler mapping `DashError` → `ErrorDto` with `HTTP_STATUS`, anything else → 500 `internal` without leaking the message; headers on every response: `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(), camera=(), microphone=()`; static serving of `apps/web/dist` with hashed assets `immutable, max-age=31536000` and `index.html` `no-cache`; SPA fallback for non-`/api`, non-`/dav` paths.

**Tests:** `GET /api/health → {ok:true, contract:1}`; `binds 127.0.0.1 only` (config rejects `0.0.0.0`); `unknown error → 500 with code internal and no stack`; `DashError('conflict') → 409`; `CSP header present on HTML and API`; `body over 1 MB → 413`.

- [ ] Standard task cycle

### Task A3: Module loader, host factory, router with enforced levels

**Files:** Create `src/core/modules/loader.ts`, `src/core/modules/host.ts`, `src/core/modules/router.ts`; Test `test/core/modules.test.ts`

**Interfaces — Produces:**
```ts
export async function loadModules(registry: typeof serverModules, db): Promise<LoadedModule[]>;   // validates manifest, runs migrations, skips disabled
export interface LoadedModule { server: ModuleServer; host: HostServices; enabled: boolean }
export function createHost(moduleId, deps: { db; http; bus; scheduler; stream; notifications; auth; config; secrets }): HostServices;
export function mountModule(app: FastifyInstance, mod: LoadedModule, auth: AuthSeam): void;
export const ROOT_MOUNT_ALLOW: Record<ModuleId, string[]> = { calendar: ['/dav', '/.well-known/caldav'] };
```
Rules: routes mount at `/api/m/<id>/…`. For every request: `requireUser` → `levelFor(user, moduleId)`; `none` → 403; route level `edit` with user level `view` → 403; validate `body`/`query` with the route's Zod schemas → 422 on failure; non-GET requests require header `X-CSRF` equal to session csrf (except `appPassword` root mounts). A handler returning `BinaryResponse` is sent with its content type, `X-Content-Type-Options: nosniff` and its cache header; anything else is sent as JSON. A module whose manifest is invalid or whose migration fails is logged and marked failed; the app still starts. `rootMounts` not in `ROOT_MOUNT_ALLOW` are refused. `host.store.db` statements are checked against the module's table prefix.

**Tests:** `invalid manifest → module skipped, others load`; `route without session → 401`; `grant none → 403`; `view user on edit route → 403`; `bad body → 422 with zod issues in details`; `POST without X-CSRF → 403`; `disabled module's routes return 404`; `rootMount not allow-listed → refused at load`; `host.store.db rejects 'SELECT * FROM users'`.

- [ ] Standard task cycle

### Task A4: Scheduler

**Files:** Create `src/core/scheduler.ts`; Test `test/core/scheduler.test.ts`, `test/core/scheduler.recovery.test.ts`

**Interfaces — Produces:**
```ts
export interface Scheduler {
  register(mod: LoadedModule): void;
  markViewed(instanceIds: InstanceId[], at: Date): void;      // from POST /api/stream/view
  setMinimal(on: boolean): void;                              // launcher minimal mode: pauses whenViewed jobs and always-jobs not flagged critical
  runNow(moduleId: ModuleId, job: string, instanceId?: InstanceId): Promise<void>;
  status(): Array<{ moduleId; job; instanceId: InstanceId | null; lastRunAt; lastOkAt; failures; nextRunAt }>;
  start(): void; stop(): Promise<void>;
}
export function createScheduler(deps: { db; now: () => Date; random: () => number; maxConcurrent?: number /* 4 */ }): Scheduler;
```
Rules: `per:'instance'` jobs run once per placed instance; `per:'module'` once. `whenViewed` runs only if the instance (or, for module jobs, any instance of that module) was marked viewed within the last 90 s; on first view after idle it runs immediately if the last run is older than `intervalSec`. Next run = `intervalSec × (0.9 … 1.1)` jitter. On failure: next run = `min(intervalSec × 2^failures, 3600 s)` with jitter. Timeout (`timeoutSec`, default 30) aborts the signal. At most 4 jobs run at once; the rest queue FIFO. After a job: write `job_state`; mark the affected snapshot `job_ok`. A job is *critical* if its module id is in `['calendar','notifications','nas','network']` (kept in one constant `CRITICAL_MODULES`).

**Tests** (fake timers, injected `now`/`random`):
- `always job runs on interval with jitter within ±10%`
- `whenViewed job does not run when not viewed`
- `whenViewed job runs immediately on first view when overdue`
- `viewed mark expires after 90 s`
- `failure backs off 2×,4×,… capped at 3600 s; success resets`
- `timeout aborts the job signal`
- `no more than 4 jobs run concurrently`
- `minimal mode pauses non-critical jobs and resumes them`
- `scheduler.recovery.test.ts` → `20 overdue jobs after downtime are spread over at least 20 s, not started in the same second`: on `start()` with overdue jobs, each gets an initial delay of `random() × min(intervalSec, 60) s`.

- [ ] Standard task cycle

### Task A5: `host.http` — allowlist, request-forgery guard, limits, cache

**Files:** Create `src/core/http/client.ts`, `src/core/http/guard.ts`, `src/core/http/cache.ts`; Test `test/core/http.guard.test.ts`, `test/core/http.limits.test.ts`, `test/core/http.cache.test.ts`

**Interfaces — Produces:**
```ts
export function createHttp(moduleId: ModuleId, manifest: ModuleManifest, deps: { db; lookup: typeof dns.lookup; lanDevices: () => string[] }): HostServices['http'];
export function classifyAddress(ip: string): 'public' | 'private' | 'loopback' | 'linklocal' | 'reserved';
```
Rules:
- `rule:'host'` (default): scheme must be `https`; hostname must equal a manifest `host` rule; resolved address must be `public`.
- `rule:'publicUrl'`: manifest must contain `{kind:'publicUrl'}`; scheme `http|https`; port 80/443 only; every resolved address must be `public`; the socket connects to the already-resolved address (no second DNS lookup); max 3 redirects, each re-checked.
- `rule:'lanDevice'`: manifest must contain `{kind:'lanDevice'}`; host must be in the admin-configured device list for this module (`config` values registered through `lanDevices()`); address must be `private`.
- Never send cookies; default `User-Agent: home-dashboard`.
- Enforce `timeoutMs` (default 10 000, cap 30 000) and `maxBytes` (default 2 MB, cap 20 MB) while streaming; exceeding either → `DashError('upstream')`.
- Non-2xx → resolves with status (modules decide), network failure → `DashError('upstream')`. `as:'json'` with unparsable body → `DashError('upstream')`.
- Cache: successful GET with `ttlSec > 0` stored in `http_cache` keyed by module+url+headers hash; honours `ETag` with `If-None-Match` after expiry; cache rows > 24 h past expiry are purged daily.

**Tests:**
- guard: `rejects host not in manifest`; `rejects http:// for host rule`; `publicUrl to 127.0.0.1, 10.0.0.5, 192.168.1.1, 169.254.169.254, [::1], fd00::1 → forbidden`; `publicUrl whose DNS returns public then private (rebinding) → forbidden`; `redirect to private address → forbidden`; `lanDevice to public address → forbidden`; `lanDevice not in device list → forbidden`; `publicUrl on port 22 → forbidden`.
- limits: `slow server past timeout → upstream`; `50 MB body is cut at maxBytes → upstream and socket destroyed`; `HTML body with as:'json' → upstream`; `500 response resolves with status 500`.
- cache: `second GET within ttl is fromCache and makes no request`; `after ttl sends If-None-Match and 304 refreshes ttl`; `POST is never cached`.

- [ ] Standard task cycle

### Task A6: `host.store` and `host.secrets`

**Files:** Create `src/core/store.ts`, `src/core/secrets.ts`; Test `test/core/store.test.ts`, `test/core/secrets.test.ts`

**Interfaces:** implements `HostServices['store']` (including `blob`: files at `<dataDir>/blobs/<moduleId>/<sha256 of key>`, written atomically via temp file + rename, limits 10 MB per blob and 500 MB per module) and `['secrets']`. Secrets: AES-256-GCM, 12-byte random nonce per value, key read once from `secretKeyFile`; file must be mode `0600` in production or startup fails.

**Tests:** `blob round-trips and is isolated per module`; `blob over 10 MB rejected`; `blob key cannot escape the module directory ("../x")`; `kv is isolated per module`; `keys(prefix) filters`; `values over 256 KB rejected`; `secret round-trips`; `ciphertext differs for same plaintext`; `wrong key → get throws internal, never returns garbage`; `key file with mode 0644 in production → startup error`.

- [ ] Standard task cycle

### Task A7: Event bus, snapshots, live stream

**Files:** Create `src/core/bus.ts`, `src/core/snapshots.ts`, `src/core/stream.ts`; Test `test/core/bus.test.ts`, `test/core/stream.test.ts`

**Interfaces — Produces:**
```ts
export interface Bus { publish(from: ModuleId | 'core', name: EventName, payload: unknown): void; subscribe(moduleId: ModuleId | 'core', name: EventName, fn): void }
export interface Stream {
  handle(req, reply): void;                                  // GET /api/stream
  sendSnapshot(moduleId, instanceId: InstanceId | null, snap): void;
  sendToUser(userId, ev: StreamEvent): void;
  disconnectUser(userId: UserId, moduleId?: ModuleId): void;
}
```
Rules: bus validates payload against `events[name]`; a module may publish only names in its `manifest.publishes` (else logged and dropped); delivery is async (`queueMicrotask`), a throwing subscriber never affects others or the publisher. `host.push` stores the snapshot (max 256 KB, else rejected and logged), computes `stale = !job_ok || age > (tile.staleAfterSec ?? 2.5 × feeding job interval)`, and sends it to connected users who (a) have level ≥ view on the module and (b) can see an instance of it (own page or shared page). On connect: send current snapshots for all visible instances, then a `ping` every 25 s. On `onGrantsChanged` to `none`: send `revoked` and stop sending that module's snapshots to that user. Max 6 streams per user; the oldest is closed. Core-owned snapshots use instance ids prefixed `core:` (`core:sun`, `core:launcher`, `core:offline`) and are sent with `stream.sendCore(key, data, userIds?)`; clients receive them as ordinary `snapshot` events.

**Tests:** `invalid payload is dropped and logged`; `undeclared event name is dropped`; `throwing subscriber does not stop other subscribers`; `connect sends current snapshots for visible instances only`; `user without grant never receives the module's snapshots`; `revoking grant sends revoked then no further snapshots`; `module-wide snapshot (instanceId null) reaches all instances' viewers`; `snapshot becomes stale after staleAfterSec`; `7th stream closes the 1st`.

- [ ] Standard task cycle

### Task A8: Pages, instances, notifications, admin module API

**Files:** Create `src/core/pages.ts`, `src/core/instances.ts`, `src/core/notifications.ts`, `src/core/admin-modules.ts`; Test `test/core/pages.test.ts`, `test/core/notifications.test.ts`

**Interfaces:** implements the REST rows in plan 01 Task F3 for pages, instances, layout, stream/view, notifications, `admin/modules`. `host.notify` writes one row per target user, applies `dedupeKey` (same module+key+user within 24 h → update row, keep unread), sends a `notification` stream event, publishes `notification.created` on the bus as `core`, and calls registered sinks (`registerNotificationSink(fn)` — used later by Web Push). The privileged `host.notifications` service (list, markRead, unreadCount, mutes; table `notification_mutes(user_id, module_id, until)`) is attached only to module ids in `PRIVILEGED = { notifications: ['notifications'] }`; muted notifications are stored already read and skip sinks.

Rules: a user sees own pages plus pages with `shared = true`; only the owner edits a page; adding an instance requires level ≥ view on its module and validates `settings` with `manifest.settings` (defaults applied); `multiInstance:false` allows one instance per user; layout items are clamped to `tile.min/max` and `GRID_COLUMNS`; instance changes call `onInstanceChange`; new users get a starter page named "Today". Notifications older than 30 days are purged daily.

**Tests:** `member cannot edit another user's page (403)`; `shared page is visible to others but instances of ungranted modules are omitted`; `instance settings validated, defaults applied`; `second instance of single-instance module → 409`; `layout clamps w to max`; `deleting a page deletes its instances and snapshots`; `dedupeKey updates instead of inserting`; `notify publishes notification.created`; `host.notifications is undefined for a non-privileged module`; `muted module's notification is stored read and not sent to sinks`; `notify without userIds targets every user with view on the module`; `module config PUT validates with manifest.config and is admin-only`.

- [ ] Standard task cycle

---

## Track B — Auth and permissions (`track/auth`)

### Task B1: Users, passwords, sessions

**Files:** Create `src/auth/schema.ts`, `src/auth/users.ts`, `src/auth/sessions.ts`, `src/auth/plugin.ts`, `src/auth/cli.ts`; Test `test/auth/login.test.ts`

**Interfaces:** implements `AuthSeam.plugin`, `requireUser`, `listUsers`. CLI: `pnpm --filter @dash/server cli user:create --name <n> --role admin` (prompts for password; used by install script for the first admin).

Rules: argon2id (`memoryCost 19456`, `timeCost 2`, `parallelism 1`); password ≥ 12 chars; session id = 32 random bytes, stored as SHA-256; cookie `dash_sid`: `HttpOnly; Secure; SameSite=Strict; Path=/`; idle expiry 30 days, absolute 180 days; `last_seen_at` updated at most once per minute; login response and `/api/me` return `MeDto` with the session's `csrf`; unknown user and wrong password take the same time and return the same `unauthenticated` error; `handle` = lower-case name without spaces, unique.

**Tests:** `login sets cookie with HttpOnly, Secure, SameSite=Strict`; `wrong password → 401 same body as unknown user`; `logout invalidates session`; `expired session → 401`; `disabled user cannot log in and existing sessions die`; `password shorter than 12 rejected`; `session id is not stored in clear`.

- [ ] Standard task cycle

### Task B2: Rate limiting and lockout

**Files:** Create `src/auth/ratelimit.ts`; Test `test/auth/ratelimit.test.ts`

Rules: keys `ip:<addr>` and `user:<name>`; 5 failures in 15 min → locked 15 min; doubling per further lock up to 24 h; success clears the user key; locked → 429 `rate_limited` with `Retry-After`. Client IP from `X-Forwarded-For` only when the peer is `127.0.0.1` (Caddy).

**Tests:** `6th attempt within window → 429 with Retry-After`; `lock expires`; `success resets counter`; `X-Forwarded-For ignored from non-loopback peer`.

- [ ] Standard task cycle

### Task B3: Grants and permission resolution

**Files:** Create `src/auth/grants.ts`; Test `test/auth/grants.test.ts`

**Interfaces:** implements `levelFor`, `onGrantsChanged`, `PUT /api/admin/grants` (`{userId, moduleId, level}`).

Rules: `admin` role → `edit` on every module; member default → `none`; a level not in `manifest.levels` is rejected; changing a grant fires `onGrantsChanged` synchronously.

**Tests:** `admin is always edit`; `member default none`; `grant 'edit' on a view-only module → 422`; `change fires callback with new level`; `non-admin cannot PUT grants (403)`.

- [ ] Standard task cycle

### Task B4: Admin user API, TOTP, app passwords, audit

**Files:** Create `src/auth/admin.ts`, `src/auth/totp.ts`, `src/auth/app-passwords.ts`; Test `test/auth/admin.test.ts`, `test/auth/totp.test.ts`, `test/auth/app-passwords.test.ts`

**Interfaces:** `GET/POST/PATCH/DELETE /api/admin/users`; `POST /api/me/totp/setup` → `{otpauthUrl, secret}`, `POST /api/me/totp/enable {code}`, `POST /api/me/totp/disable {password}`; `GET/POST/DELETE /api/me/app-passwords` (POST returns the generated password once: 24 chars base32 in groups of 4); implements `verifyAppPassword`.

Rules: TOTP secret stored encrypted; ±1 step window; a used code cannot be reused within its window; app passwords hashed with argon2id, scope `caldav` only, never valid for `/api/*`; the last admin cannot be deleted or demoted; every login, logout, failed login, grant change, user change, app-password create/delete is written through `CoreSeam.audit`.

**Tests:** `login with TOTP enabled requires code`; `replayed code rejected`; `cannot delete last admin (409)`; `app password verifies via Basic header and updates last_used_at`; `app password rejected on /api/me`; `deleted app password stops working`; `audit rows written for login, failed login, grant change`.

- [ ] Standard task cycle

---

## Track C — Web shell (`track/web-shell`)

All server calls are mocked with MSW using the DTO schemas from `@dash/contract`.

### Task C1: App skeleton, API client, sign-in

**Files:** Create `apps/web/package.json` (`@dash/web`), `vite.config.ts`, `index.html`, `src/main.ts`, `src/shell/App.svelte`, `src/lib/api.ts`, `src/lib/session.svelte.ts`, `src/shell/Login.svelte`; Test `test/shell/api.test.ts`, `test/shell/login.test.ts`

**Interfaces — Produces:**
```ts
export const api: { get<T>(path, schema?: z.ZodType<T>): Promise<T>; post…; put…; patch…; delete… };   // adds X-CSRF, parses ErrorDto into DashError
export function moduleApi(moduleId: ModuleId): ModuleApi;
export const session: { me: MeDto | null; login(name, password, totp?): Promise<void>; logout(): Promise<void>; refresh(): Promise<void> };
```
Rules: on `unauthenticated` from any call → clear session, show Login; Login shows a TOTP field only after the server answers `invalid` with `details.totpRequired`.

**Tests:** `api adds X-CSRF on non-GET`; `ErrorDto becomes DashError with code`; `401 anywhere returns to login`; `login flow with TOTP step`.

- [ ] Standard task cycle

### Task C2: Live stream store

**Files:** Create `src/lib/stream.svelte.ts`; Test `test/shell/stream.test.ts`, `test/shell/stream.reconnect.test.ts`

**Interfaces — Produces:**
```ts
export const stream: {
  snapshots: Record<InstanceId, SnapshotDto>;              // reactive
  status: 'connecting' | 'live' | 'offline';
  connect(): void; disconnect(): void;
  setVisible(ids: InstanceId[]): void;                     // posts /api/stream/view every 30 s while document is visible
  on(type: StreamEvent['type'], fn): () => void;
};
```
Rules: reconnect with backoff 1 s → 30 s (jitter); reconnect immediately on `online` event and on `visibilitychange` to visible; if no `ping` for 60 s treat as dead and reconnect; after reconnect the server's fresh snapshots replace local ones; `revoked` removes that module's snapshots; `setVisible` uses an `IntersectionObserver` on tiles (track C3 wires it).

**Tests:** `snapshot event updates store`; `revoked removes module snapshots`; `reconnect.test` → `after 60 s without ping reconnects`; `visibilitychange to visible reconnects at once when offline`; `backoff grows and is capped at 30 s`; `after reconnect stale local data is replaced, no page reload`; `view heartbeat stops while document hidden`.

- [ ] Standard task cycle

### Task C3: Pages and grid

**Files:** Create `src/shell/Pages.svelte`, `src/shell/PageTabs.svelte`, `src/shell/Grid.svelte`, `src/shell/MobileStack.svelte`, `src/lib/pages.svelte.ts`, `src/lib/grid.ts`; Test `test/shell/pages.test.ts`, `test/shell/grid.test.ts`

Rules: viewport ≥ 900 px → 12-column gridstack with row height `GRID_ROW_PX`; narrower → single-column stack ordered by `mobileOrder`, pages change by horizontal swipe (pointer events, 60 px threshold) and by tabs; current page in the URL (`/p/<id>`); layout changes debounce 500 ms then `PUT /api/pages/:id/layout`; drag/resize only in edit mode; a `layout` stream event for the current page refetches it unless the user is mid-edit.

**Tests:** `renders one tile frame per instance`; `mobile order follows mobileOrder`; `swipe left goes to next page`; `layout PUT is debounced to one call`; `drag disabled outside edit mode`; `resize clamps to manifest min/max`.

- [ ] Standard task cycle

### Task C4: Tile frame, error boundary, detail pane

**Files:** Create `packages/ui/package.json` (`@dash/ui`), `packages/ui/src/{Tile,TileHeader,Pane,Icon,Button,Field,Empty,Stale}.svelte`, `apps/web/src/shell/TileHost.svelte`, `src/shell/DetailHost.svelte`; Test `test/shell/tilehost.test.ts`, `test/shell/pane.test.ts`

**Interfaces — Produces** (`@dash/ui`, used by every module and theme):
`<Tile title icon stale updatedAt onSettings>` (slot body), `<Pane title onClose>` , `<Icon name size>`, `<Button variant="primary|ghost|danger" data-edit?>`, `<Field label help error>`, `<Empty text>`, plus `formatRelative(date, now, t)`.

Rules: `TileHost` lazy-loads the module client, resolves a theme tile override if present (seam `theme.tileFor(moduleId)` from track D, stubbed here), passes `TileProps`; a throwing tile/detail is caught by `<svelte:boundary>` and replaced by a "module failed" tile with a retry button; freshness footer shows `formatRelative`; detail pane is a `<dialog>` centred with max 960×(90 vh), full-screen below 700 px; closes on ✕, Escape, backdrop click; focus is trapped and returns to the tile; URL reflects an open pane (`?d=<instanceId>`), so Back closes it.

**Tests:** `tile that throws shows failure placeholder and others still render`; `stale flag shows stale badge`; `Escape closes pane and restores focus`; `Back button closes pane`; `pane is full-screen under 700 px`; `override tile used when theme provides one, default otherwise`.

- [ ] Standard task cycle

### Task C5: Settings — generated forms, edit mode, catalog

**Files:** Create `src/shell/SettingsDialog.svelte`, `src/lib/schema-form.ts`, `src/shell/SchemaForm.svelte`, `src/shell/EditBar.svelte`, `src/shell/Catalog.svelte`; Test `test/shell/schema-form.test.ts`, `test/shell/edit.test.ts`

**Interfaces — Produces:**
```ts
export function describeSchema(schema: z.ZodObject): FieldSpec[];
export type FieldSpec = { key: string; label: string; help?: string; required: boolean; default?: unknown } &
  ( { kind: 'string'; widget?: 'text'|'textarea'|'url'|'color'|'icon'|'secret'|'timezone' } | { kind: 'number'; min?: number; max?: number; step?: number }
  | { kind: 'boolean' } | { kind: 'enum'; options: string[] } | { kind: 'list'; of: FieldSpec } | { kind: 'group'; fields: FieldSpec[] } );
```
Schema authors annotate with `.meta({ label, help, widget })` (Zod 4). Supported: string, number, boolean, enum, array of those, array of flat objects, one level of nested object. Anything else → the module must ship `Settings.svelte`.

Rules: ⚙ opens instance settings (generated form or module's `Settings`); Save validates with the Zod schema client-side and PATCHes; edit mode (✎) shows drag handles, remove buttons, "add module" opening the catalog; catalog lists modules the user has a grant for, with name, description, icon; adding places the tile at the first free slot with `tile.default` size.

**Tests:** `describeSchema maps each supported kind`; `unsupported schema throws a clear error naming the key`; `invalid input shows the zod message on the field`; `catalog hides modules without grant`; `add places tile and POSTs instance`; `remove asks for confirmation`.

- [ ] Standard task cycle

### Task C6: Top bar, global settings, admin screens, PWA

**Files:** Create `src/shell/TopBar.svelte`, `src/shell/Notifications.svelte` (badge + dropdown only; the module provides the full view), `src/shell/settings/{Account,Appearance,Users,Grants,Modules,About}.svelte`, `src/sw.ts`, `public/manifest.webmanifest`, icons; Test `test/shell/admin.test.ts`, `test/shell/sw.test.ts`

Rules: Appearance: theme picker, mode policy (`day|night|system|sun`), background per page, intensity override; Users/Grants/Modules visible to admins only (grant matrix: users × modules, cells none/view/edit limited to `manifest.levels`); Account: password change, TOTP, app passwords (shown once, with copy button and the CalDAV URL). Service worker (Workbox): precache shell; module/theme chunks `StaleWhileRevalidate`; `/api/*` never cached; offline → shell loads and shows last snapshots kept in `sessionStorage`-backed store with an "offline" banner; a new version shows "Update available — reload".

**Tests:** `member does not see admin sections`; `grant matrix only offers levels in manifest.levels`; `app password is displayed once`; `sw never caches /api`; `offline banner appears when stream status is offline`.

- [ ] Standard task cycle

---

## Track D — Theme engine and Default theme (`track/theme-engine`)

### Task D1: Theme loading, tokens, mode policy

**Files:** Create `apps/web/src/theme/engine.svelte.ts`, `src/theme/mode.ts`; Test `test/theme/engine.test.ts`, `test/theme/mode.test.ts`

**Interfaces — Produces:**
```ts
export const theme: {
  current: ThemeManifest; id: ThemeId; mode: Mode; intensity: Intensity;
  set(id: ThemeId): Promise<void>;                         // lazy-loads manifest + css, sets <html data-theme data-mode>
  tileFor(moduleId: ModuleId): Promise<Component<TileProps> | null>;
  clockFace(id?: string): Promise<Component<ClockFaceProps>>;
  icon(name: string): string;                              // theme icon → default theme icon → module icon
  chart(): ChartPalette;
  t: Translate;                                            // theme strings → locale strings → fallback
};
export function resolveMode(policy: 'day'|'night'|'system'|'sun', ctx: { systemDark: boolean; sun: { isDay: boolean } | null; now: Date }): Mode;
```
Rules: `sun` policy uses the latest `time.sun` data delivered through a core snapshot `core:sun` (weather module publishes `time.sun`; server keeps the last value; without it, falls back to day 07:00–19:00 local); switching theme or mode never reloads the page; previous theme CSS is removed after the new one has loaded (no flash); a theme failing to load falls back to `default` with a notification. The engine is provided to modules through Svelte context key `dash:theme` (`{ clockFace, icon, chart, mode }`). `tileFor` returns `null` when the override module exports `minSize` larger than the tile's current size.

**Tests:** `resolveMode for each policy`; `sun policy without data uses 07–19 fallback`; `set() swaps data-theme and unloads old css`; `broken theme falls back to default`; `t prefers theme string over locale string over fallback`; `icon falls back to default theme`.

- [ ] Standard task cycle

### Task D2: Background host and intensity governor

**Files:** Create `src/theme/BackgroundHost.svelte`, `src/theme/intensity.ts`, `src/theme/env.svelte.ts`; Test `test/theme/intensity.test.ts`

**Interfaces — Produces:**
```ts
export function decideIntensity(i: { userOverride: Intensity | null; reducedMotion: boolean; saveData: boolean; batteryLow: boolean; avgFps: number | null; hidden: boolean }): Intensity;
export const sceneEnv: SceneEnv;     // reactive; fed by core:sun, weather and moon snapshots when the user can see those modules
```
Rules: override wins; else `reducedMotion || saveData → static`; `batteryLow (<20 % and not charging) → calm`; `avgFps < 30` over 3 s → drop one level (full→calm→static), never climbs back within a session; document hidden → scenes paused. `static` renders the scene's `staticImage` only and does not load the scene component. Background is per page (`PageDto.background`), `"rotate"` cycles the theme's scenes daily.

**Tests:** `override wins`; `reduced motion → static`; `low fps drops one level and stays`; `static does not import the scene component`; `rotate picks by day index`.

- [ ] Standard task cycle

### Task D3: Chart wrapper

**Files:** Create `packages/ui/src/Chart.svelte`, `packages/ui/src/chart.ts`; Test `packages/ui/test/chart.test.ts`

**Interfaces — Produces:** `<Chart kind="line|area|bar|spark" series={[{label, points:[t,v][]}]} unit height />` drawing with uPlot and the theme's `ChartPalette`; re-colours on theme/mode change without re-creating data; `spark` has no axes; touch tooltips. `downsample(points, maxPoints)` (largest-triangle-three-buckets), default 300 points.

**Tests:** `downsample keeps first and last and returns ≤ max`; `palette change updates series colours`; `empty series shows Empty`.

- [ ] Standard task cycle

### Task D4: Default theme and theme contract suite

**Files:** Create `themes/default/{package.json,theme.ts,tokens.css,base.css}`, `themes/default/background/{Plain,Gradient}.svelte` + static images, `themes/default/clock/{Digital,Analog}.svelte`, `themes/default/icons.ts` (all `ICON_KEYS`), `packages/module-kit/src/suite-theme.ts` (orchestrator applies this one file on `main`), `themes/default/tests/theme.test.ts`

**Interfaces — Produces:** `runThemeContractSuite(theme: ThemeManifest, opts: { themeDir: string })` with cases: `manifest is valid`; `tokens.css defines every REQUIRED_TOKENS for day and night`; `contrast pairs meet minimums in both modes` (parse token colour values, compute WCAG ratio); `every background has a static image file`; `each clock face renders at 2×1 and 6×4`; `each background renders in full, calm, static without throwing`; `every tile override renders with that module's tile fixture` (skipped when the module is absent); `css contains no @import and no url() to another origin`; `fonts referenced exist in the theme folder`.

Default theme: neutral, system font stack, light day / dark night, two backgrounds, two clock faces. It is the fallback for icons and the reference for theme authors.

**Tests:** `runThemeContractSuite(default)` all green; a deliberately broken fixture theme in `packages/module-kit/test` fails `tokens` and `contrast`.

- [ ] Standard task cycle

---

## Track E — Deployment and operations (`track/deploy`)

Shell scripts are tested with `bats` inside a Debian stable container (`deploy/test/Dockerfile`); steps that need systemd are tested with `systemd-analyze verify` and on the device at gate G3.

### Task E1: Install script

**Files:** Create `deploy/install.sh`, `deploy/lib/*.sh`, `deploy/test/install.bats`

Rules — `install.sh` is idempotent, runs as root, and does in order: (1) check Debian stable, architecture, free disk ≥ 2 GB, RAM; (2) install packages: `curl ca-certificates git sqlite3 caddy ufw unattended-upgrades`; (3) install Node 24 from NodeSource at a pinned major and enable `corepack` for pnpm; (4) create system user `dashboard` (no login) and directories `/opt/dashboard` (code, root-owned), `/var/lib/dashboard` (data, `dashboard:dashboard 0750`), `/etc/dashboard` (`root:dashboard 0750`); (5) create `/etc/dashboard/secret.key` once (32 bytes, `0640 root:dashboard`), never overwrite; (6) `pnpm install --frozen-lockfile --ignore-scripts` then rebuild only allow-listed native deps (`better-sqlite3`, `@node-rs/argon2`, `sharp`); `pnpm audit --prod --audit-level high` — fail on findings unless `--allow-audit`; (7) `pnpm build` with `NODE_OPTIONS=--max-old-space-size=1536`; (8) if a database exists: back it up to `/var/lib/dashboard/backups/pre-<version>-<timestamp>.sqlite`; (9) run migrations; (10) install systemd units, Caddyfile, ufw rules (E2–E4) and reload; (11) restart service, wait up to 30 s for `/api/health`; (12) on first install prompt for the first admin (`user:create`); (13) print summary and URL. Any failure after step 8 prints the exact rollback command. Flags: `--no-firewall`, `--allow-audit`, `--yes`.

**Tests (bats, container):** `fresh run creates user, dirs, key with correct modes`; `second run changes nothing and exits 0`; `existing secret.key is not overwritten`; `non-Debian exits 1 with message`; `failed health check exits non-zero and prints rollback command`.

- [ ] Standard task cycle

### Task E2: systemd unit and sandbox

**Files:** Create `deploy/systemd/dashboard.service`, `deploy/systemd/dashboard-netscan.service` (+ `.socket`), `deploy/test/units.bats`

Rules — `dashboard.service`: `User=dashboard`, `WorkingDirectory=/opt/dashboard`, `EnvironmentFile=/etc/dashboard/env`, `ExecStart=/usr/bin/node apps/server/dist/main.js`, `Restart=on-failure`, `RestartSec=3`, `MemoryMax=400M`, `MemoryHigh=300M`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/dashboard`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectKernelTunables=yes`, `ProtectControlGroups=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `RestrictNamespaces=yes`, `LockPersonality=yes`, `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`. `dashboard-netscan`: socket-activated helper (unix socket `/run/dashboard/netscan.sock`, group `dashboard`) with only `CAP_NET_RAW`, `AF_PACKET` allowed; protocol defined in plan 05 (Network module).

**Tests:** `systemd-analyze verify` passes for each unit; `systemd-analyze security dashboard.service` exposure score ≤ 2.5 (checked on device at G3; recorded in `docs/ops/security-score.txt`).

- [ ] Standard task cycle

### Task E3: Caddy, Tailscale HTTPS, firewall, SSH

**Files:** Create `deploy/caddy/Caddyfile.tmpl`, `deploy/ufw.sh`, `deploy/ssh/60-dashboard.conf`, `deploy/tailscale-acl.example.jsonc`, `deploy/test/caddy.bats`

Rules — Caddy: site `{$TS_HOSTNAME}` (the machine's `*.ts.net` name), `bind` to the Tailscale address, certificate via Caddy's built-in Tailscale integration (the `caddy` user is allowed with `TS_PERMIT_CERT_UID`), `encode zstd br gzip`, `reverse_proxy 127.0.0.1:8787` with `flush_interval -1` for `/api/stream`, HSTS header, request body limit 25 MB, `/.well-known/caldav` → 301 `/dav/`; launcher apps are proxied under `/apps/<name>/*` from a generated snippet (plan 08). ufw: default deny incoming, allow outgoing; allow `443/tcp` on `tailscale0`; allow `22/tcp` from the LAN subnet (detected, confirm prompt) and on `tailscale0`; allow mDNS out for WLED discovery. SSH drop-in: `PasswordAuthentication no`, `PermitRootLogin no`, `KbdInteractiveAuthentication no`. ACL example: second person's devices may reach `tag:dashboard:443` only.

**Tests:** `caddy validate` passes on the rendered template; `ufw.sh --dry-run` prints exactly the expected rule list; sshd `-t` accepts the drop-in.

- [ ] Standard task cycle

### Task E4: Doctor command and ops docs

**Files:** Create `apps/server/src/core/doctor.ts` (orchestrator applies on `main` after track A merges, from this track's patch), `deploy/doctor.sh`, `docs/ops/setup-guide.md`, `docs/ops/update-and-rollback.md`, `docs/ops/second-person.md`

Rules — `doctor` prints one line per check with OK/WARN/FAIL and exits non-zero on FAIL: service active; health endpoint; disk free > 15 %; database integrity; last backup < 26 h (WARN until backups exist); certificate expiry > 14 days; failing jobs (failures ≥ 5); memory under `MemoryHigh`; Tailscale connected; firewall active; pending security updates. Setup guide covers: Debian minimal install, BIOS power-on-after-power-loss, SSH key setup, Tailscale install and ACL, running `install.sh`, first sign-in, installing the PWA on phone, adding the second person. Update doc = the three-command flow plus rollback.

**Tests:** unit tests for each doctor check with injected probes (`disk 10 % → FAIL`, `backup 30 h → WARN`, `cert 5 days → FAIL`).

- [ ] Standard task cycle

---

### Gate G2

- [ ] All five branches merged; `pnpm check && pnpm build` green.
- [ ] `pnpm dev`: create admin, sign in, add a page, switch day/night, Default theme renders, empty catalog shows "no modules installed".
- [ ] `pnpm e2e` smoke: sign-in → empty page → sign-out.
