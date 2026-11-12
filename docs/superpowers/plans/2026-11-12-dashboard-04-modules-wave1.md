# Dashboard 04 — Modules Wave 1 (Core of the Day)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the five modules that make the dashboard guide a day: Calendar, Todo, Weather, Today Briefing, Notification Center.

**Architecture:** One agent per module, each in `modules/<id>/` only, against the mock host. Modules interact solely through events in `@dash/contract`.

**Tech Stack:** as master plan; Calendar adds `ical.js` (parsing, generation, recurrence expansion, time zones).

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (sections 5.4, 8.1, 8.5)

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply. Every agent follows **Part 1 of plan 03 (Module playbook)** and the **Standard task cycle**.

## Review Focus

Owned here: master Review Focus #1 (Calendar C2), #3 (Calendar C3, Todo T2), #4 (Calendar C5).

**Parallelism:** the five modules are independent. Inside Calendar, tasks C1→C6 are serial; C7 and C8 (UI) can start after C3 with a second agent if desired.

---

## Module: `calendar` (branch `module/calendar`)

**Manifest decisions:** scope `shared`; `multiInstance: true`; tile default 4×4, min 2×2, max 12×8; levels `['view','edit']`; jobs: `reminders` (30 s, always, module), `derive` (300 s, always, module), `subscriptions` (3600 s, always, module); publishes `calendar.event.changed`, `calendar.event.upcoming`, `calendar.event.started`, `calendar.day.summary`, `todo.create.request`, `todo.remove.request`, `wled.apply.request`, `pin.request`, `countdown.request`; subscribes `todo.changed`; outbound `[{kind:'publicUrl'}]`; `rootMounts` `/dav`, `/.well-known/caldav` with `appPassword` (handlers added in plan 08).

Instance settings: `calendarIds: string[]` (empty = all visible), `defaultView: 'agenda'|'day'|'week'|'month'` (default `agenda`), `weekStart: 'mon'|'sun'` (default `mon`), `daysAhead: number` (1–14, default 3).
Module config: `defaultReminderMin: number` (default 0 = none), `deriveHorizonDays` (default 14).

### Task C1: Calendars and sharing

**Files:** `modules/calendar/manifest.ts`, `server/migrations.ts`, `server/calendars.ts`; Test `tests/calendars.test.ts`

Tables: `m_calendar_calendars(id, owner_id, name, color, kind 'local'|'subscription', source_url, sync_seq, created_at)`, `m_calendar_shares(calendar_id, user_id, level 'view'|'edit')`.

```ts
export function accessLevel(db, calendarId: string, userId: UserId): 'none'|'view'|'edit'|'owner';
export function visibleCalendars(db, userId: UserId): CalendarRow[];
export function createCalendar(db, ownerId, input: { name: string; color: string }): CalendarRow;
export function share(db, calendarId, ownerId, targetUserId, level: 'view'|'edit'|'none'): void;   // owner only
```
Routes: `GET /calendars` (view), `POST /calendars` (edit), `PATCH /calendars/:id` (edit, owner), `DELETE /calendars/:id` (edit, owner), `PUT /calendars/:id/shares` (edit, owner). Every user gets a calendar "Personal" on first access. Effective right on an event = `min(module level, calendar access)`.

**Tests:** `owner has owner access; stranger none`; `shared view user cannot write`; `only owner may share or delete`; `module level view caps calendar edit share to read-only`; `first access creates Personal once`.

- [ ] Standard task cycle

### Task C2: Event storage and recurrence

**Files:** `server/ical.ts`, `server/events-repo.ts`, `server/recurrence.ts`; Test `tests/ical.test.ts`, `tests/recurrence.test.ts`, `tests/recurrence.dst.test.ts`; fixtures `fixtures/*.ics` (simple, all-day, weekly with EXDATE, overridden instance, floating time, foreign time zone)

Table: `m_calendar_events(uid, calendar_id, recurrence_id '' for master, ics TEXT, etag, summary, description, location, dtstart_utc, dtend_utc, all_day, tzid, has_rrule, until_utc, tags json, mentions json, is_private, creator_id, updated_at, PRIMARY KEY(calendar_id, uid, recurrence_id))`, `m_calendar_changes(calendar_id, seq, uid, deleted, at)`.

```ts
export interface EventInput { title: string; description?: string; location?: string; start: string; end: string; allDay: boolean;
  timeZone: string; rrule?: string | null; exdates?: string[] }
export function toVEvent(input: EventInput, uid: string, now: Date): string;                 // full VCALENDAR text incl. VTIMEZONE
export function fromVCalendar(ics: string): ParsedEvent[];                                    // master + overrides; throws DashError('invalid')
export function expand(events: StoredEvent[], from: Date, to: Date, max?: number /* 2000 */): Occurrence[];
export function upsertEvent(db, calendarId, ics: string, opts: { ifMatch?: string | null; creatorId: UserId; now: Date }): { uid: string; etag: string; created: boolean };
export function deleteEvent(db, calendarId, uid: string, opts: { ifMatch?: string | null; now: Date }): void;
```
Rules: the raw `ics` is the source of truth and is stored byte-for-byte as received (needed for CalDAV); indexed columns are derived. `etag` = `"` + SHA-256(ics) first 16 hex + `"`. Every upsert/delete appends to `m_calendar_changes` and bumps the calendar's `sync_seq` in the same transaction. Recurrence expands in the event's own time zone; all-day events are date-only and zone-less; range `to − from` is capped at 400 days; `COUNT`/`UNTIL`, `EXDATE`, overridden instances (`RECURRENCE-ID`) are honoured.

**Tests:**
- `round-trips each fixture: fromVCalendar(toVEvent(x)) equals x`
- `weekly event with EXDATE skips that date`
- `overridden instance replaces the generated one`
- `expand caps at max and at 400 days`
- `recurrence.dst.test.ts`: `weekly 09:00 Europe/Berlin event is at 08:00Z before 2027-03-28 and 07:00Z after`; `same for the October change back`; `all-day event on 2027-03-28 has the same date for a user in America/New_York and Asia/Tokyo`; `event stored in America/New_York shows at correct Berlin wall time across both regions' differing DST dates`; `02:30 local on the spring-forward day resolves to 03:30 and does not vanish`.
- `malformed ICS → DashError('invalid'), nothing stored`

- [ ] Standard task cycle

### Task C3: Event API with conflict detection

**Files:** `server/routes-events.ts`, `server/dto.ts`; Test `tests/events.test.ts`, `tests/events.conflict.test.ts`

```ts
export const OccurrenceDto = z.object({ uid: z.string(), calendarId: z.string(), etag: z.string(), recurrenceId: z.string().nullable(),
  title: z.string(), displayTitle: z.string(), description: z.string(), location: z.string(), start: z.string(), end: z.string(),
  allDay: z.boolean(), timeZone: z.string(), rrule: z.string().nullable(), tags: z.array(z.string()), mentions: z.array(z.string()),
  color: z.string(), editable: z.boolean() });
```
Routes: `GET /events?from&to&calendarIds` (view) → `OccurrenceDto[]`; `POST /events` (edit) `{calendarId, ...EventInput}`; `PUT /events/:uid` (edit) `{calendarId, etag, scope: 'all'|'this'|'future', occurrenceStart?, ...EventInput}`; `DELETE /events/:uid` (edit) `{calendarId, etag, scope, occurrenceStart?}`.

Rules: write requires calendar access ≥ edit; `etag` mismatch → `DashError('conflict')` with the current event in `details`; `scope:'this'` writes an override or EXDATE; `scope:'future'` truncates the master with `UNTIL` and creates a new series; events with `#private` are returned only to their creator (others on a shared calendar get nothing, not a "busy" block); `displayTitle` = title with `!command` tokens removed; every write publishes `calendar.event.changed` and triggers `derive` via `host` (call the derive function directly inside the module).

**Tests:** `conflict.test`: `PUT with stale etag → 409 and stored event unchanged`; `two concurrent PUTs with the same etag: exactly one succeeds`; `DELETE with stale etag → 409`. Others: `stranger gets no events from unshared calendar`; `private event invisible to other user on shared calendar`; `scope this creates override, series otherwise unchanged`; `scope future splits series`; `view-share user cannot write (403)`; `displayTitle strips !remind 30m`.

- [ ] Standard task cycle

### Task C4: Read-only subscriptions

**Files:** `server/subscriptions.ts`; Test `tests/subscriptions.test.ts`; fixtures `fixtures/holidays.ics`

Routes: `POST /subscriptions` (edit) `{name, url, color}`; `DELETE /subscriptions/:id` (edit, owner). Job `subscriptions`: for each subscription calendar fetch `source_url` with `rule:'publicUrl'`, `as:'text'`, `ttlSec:3000`, `maxBytes: 5_000_000`; parse; replace the calendar's events in one transaction only if parsing fully succeeded; max 5000 events; events in subscription calendars are never editable and commands in them are ignored.

**Tests:** `import replaces previous events atomically`; `parse failure keeps old events and notifies owner once (dedupeKey)`; `5001 events → rejected`; `subscription events have editable:false`; `commands in subscription events are not executed`.

- [ ] Standard task cycle

### Task C5: Command parser and derived items

**Files:** `server/commands/parse.ts`, `server/commands/registry.ts`, `server/commands/*.ts` (one file per command), `server/derive.ts`; Test `tests/commands.parse.test.ts`, `tests/derive.test.ts`, `tests/commands.idempotent.test.ts`

Table: `m_calendar_derived(calendar_id, uid, occurrence, source_key PRIMARY KEY, kind, payload_hash)`, `m_calendar_reminders(source_key PRIMARY KEY, uid, occurrence, fire_at, user_ids json, fired)`.

```ts
export type Token = { kind: 'mention'; handle: string } | { kind: 'tag'; name: string; args: string } | { kind: 'bang'; name: string; args: string };
export function parseCommands(text: string): Token[];
export interface CommandPlugin { match(t: Token): boolean; derive(ctx: { event: Occurrence; token: Token; users: User[]; creatorId: UserId }): Derived[] }
export type Derived = { sourceKey: string; kind: 'event'; name: EventName; payload: unknown; removeWith?: { name: EventName; payload: unknown } }
                    | { sourceKey: string; kind: 'reminder'; fireAt: string; userIds: UserId[] }
                    | { sourceKey: string; kind: 'flag'; flag: 'private'|'outdoor'|'birthday' };
export function reconcile(db, host: HostServices, now: Date): void;   // the `derive` job and post-write hook
```
Grammar: tokens are found in title and description. `@handle` = `@` + `[a-z0-9._-]+` (case-insensitive, must match a user handle, else ignored). `#name` and `!name` = sigil + `[a-z]+`; arguments run to the next token or end of line. Tokens inside URLs or e-mail addresses are ignored. Source key format: `calendar:<uid>:<occurrence ISO date or 'single'>:<kind>:<stable arg hash>`.

| Token | Derived |
|---|---|
| `@handle` | `todo.create.request` `{list:'deadline', title: displayTitle, due: occurrence start, assigneeId}`; remove = `todo.remove.request` |
| `#shopping a, b` | one `todo.create.request` per comma-separated item, `list:'shopping'`, `due:null` |
| `#chore` | `todo.create.request` `list:'chores'`, due = start, assignee = first mention or creator |
| `!remind <n>(m\|h\|d)` | reminder at start − n for creator + mentioned users |
| `!prep <n>(h\|d)` | `todo.create.request` `list:'deadline'`, title `Prepare: <displayTitle>`, due = start − n |
| `!countdown` | `countdown.request` `{title, at: start}` |
| `!pin` | `pin.request` `{title, date: start date, userIds: creator + mentions}` |
| `!wled <preset>` or `!wled <target>:<preset>` | reminder-like entry firing at start that publishes `wled.apply.request` (target default `all`) |
| `#outdoor`, `#private` | flags stored on the event (`tags`, `is_private`) |
| `#birthday [year]` | flag; if the event has no RRULE the editor offers yearly repeat; age = occurrence year − year |

Rules — `reconcile`: compute the desired derived set for all occurrences starting within `[now − 1 day, now + deriveHorizonDays]`; diff against `m_calendar_derived` by `source_key` and `payload_hash`; publish create for new/changed, `removeWith` for vanished; all bookkeeping for one event in one transaction, written **before** publishing (a crash between may re-publish; receivers are idempotent by `sourceKey`). Unknown `!`/`#` names are ignored silently (they are ordinary text).

**Tests:**
- parse: `finds @dani, #shopping milk, eggs and !remind 30m in one line`; `ignores @ inside an e-mail and # inside a URL`; `unknown handle ignored`; `args stop at next token`.
- derive: `@dani creates one todo request due at start`; `#shopping a, b creates two`; `editing title to remove @dani publishes todo.remove.request`; `deleting event removes all its derived items and reminders`; `weekly event derives only occurrences within horizon`; `moving an event updates due date under the same sourceKey`; `!prep 2d is due two days before`.
- `commands.idempotent.test.ts`: `reconcile twice publishes nothing the second time`; `simulated crash after bookkeeping commit and before publish: next reconcile publishes nothing new but a forced replay publishes identical sourceKeys`; `restart with the same data creates no duplicates`.

- [ ] Standard task cycle

### Task C6: Reminders, upcoming, day summary

**Files:** `server/reminders.ts`; Test `tests/reminders.test.ts`

Job `reminders` (30 s): fire due `m_calendar_reminders` (notify users, level `info`, `dedupeKey` = source key, url to the event; for wled entries publish the request); publish `calendar.event.upcoming` for each user's next event within 120 min when `minutesUntil` crosses 60, 30, 15, 5, 0 (and once on change); publish `calendar.event.started` once per occurrence at start; publish `calendar.day.summary` per user at local midnight, on any change to today's events, and at startup; push the tile snapshot per instance: `{ today: OccurrenceLite[], next: OccurrenceLite[] (≤ 8 within daysAhead), calendars: {id,name,color}[] }`.

**Tests:** `reminder fires once`; `missed reminders older than 6 h are dropped silently after downtime, newer ones fire late`; `upcoming published at each threshold once`; `started published once per occurrence`; `day.summary lists only that user's visible events`; `snapshot excludes other users' private events`.

- [ ] Standard task cycle

### Task C7: Tile and agenda

**Files:** `client/Tile.svelte`, `client/Agenda.svelte`, `client/format.ts`; Test `tests/client.test.ts`

Tile: today's remaining events then next days grouped by date, colour dot per calendar, mentions and tags as chips, all-day first; at min size shows next event only. "+" button (`data-edit`) opens the detail pane in create mode.

**Tests:** contract suite; `groups by day with Today / Tomorrow labels`; `min size shows a single next event`; `no events shows empty state`.

- [ ] Standard task cycle

### Task C8: Detail — month/week/day views and editor

**Files:** `client/Detail.svelte`, `client/{Month,Week,Day}.svelte`, `client/Editor.svelte`, `client/RepeatPicker.svelte`, `client/store.svelte.ts`; Test `tests/detail.test.ts`

Rules: view switcher; calendar filter with colours; month grid (6 rows), week/day time grid with drag to move and resize (edit level, 15-minute snap); click empty slot creates; editor fields: title (with live preview of recognised commands as chips and a help popover listing all commands), calendar, start/end, all-day, time zone, repeat (none/daily/weekly on days/monthly/yearly/custom interval, end never/on date/after n), location, description; on recurring events ask this/future/all; conflict (409) shows "changed elsewhere" with reload/overwrite choice; on phones week view becomes a 3-day view.

**Tests:** `month grid starts on configured week start`; `drag moves event by 30 min and sends PUT with etag`; `recurring edit asks scope`; `409 shows conflict dialog`; `command chips preview @dani and !remind 30m`; `view user sees no editor`.

- [ ] Standard task cycle

---

## Module: `todo` (branch `module/todo`)

**Manifest decisions:** scope `shared`; `multiInstance: true`; tile default 3×4, min 2×2, max 6×8; levels `['view','edit']`; jobs: `rollover` (900 s, always, module); publishes `todo.changed`, `todo.day.summary`; subscribes `todo.create.request`, `todo.remove.request`, `item.readLater`; outbound `[]`.

Instance settings: `lists: TodoList[]` (default all), `show: 'mine'|'all'` (default `mine`), `hideDone: boolean` (default true).

### Task T1: Items repo and rules

**Files:** `manifest.ts`, `server/migrations.ts`, `server/items.ts`, `server/buckets.ts`; Test `tests/items.test.ts`, `tests/buckets.test.ts`

Table: `m_todo_items(id, list, title, icon, note, qty, due, owner_id, assignee_id, visibility 'private'|'shared', done, done_at, done_by, version, source_key UNIQUE NULL, url, repeat_every, repeat_unit, rotation json, rotation_idx, created_at, updated_at)`.

```ts
export function visibleTo(item, userId): boolean;        // shared, or owner, or assignee
export function bucketOf(item, now: Date, tz: string): 'overdue'|'today'|'week'|'month'|'later'|'none';
export function completeItem(db, id, userId, version, now): Item;   // for repeating items: creates the next occurrence, advances rotation
```
Rules: `shopping` and `chores` default to `shared`, others to `private`; `week`/`month` lists get an implicit due date at the end of the current ISO week / month when none is given; repeating chores on completion spawn the next item at `due + every×unit` with the next assignee in `rotation`; title ≤ 200 chars; icon is an icon key or a single emoji.

**Tests:** `private item invisible to others, visible to assignee`; `week item without due gets Sunday 23:59 local`; `bucketOf across week and month boundaries`; `completing weekly chore creates next with rotated assignee`; `rotation wraps`.

- [ ] Standard task cycle

### Task T2: API with versions, and request handling

**Files:** `server/index.ts`, `server/requests.ts`; Test `tests/routes.test.ts`, `tests/items.conflict.test.ts`, `tests/requests.test.ts`

Routes: `GET /items?list&show` (view); `POST /items` (edit); `PATCH /items/:id` (edit) `{version, ...fields}`; `POST /items/:id/done` (edit) `{version, done}`; `DELETE /items/:id` (edit) `{version}`; `POST /items/clear-done` (edit) `{list}`.

Rules: `version` mismatch → `conflict` with the current item in `details`; only owner or assignee may edit a private item; `todo.create.request` upserts by `source_key` (update title/due/assignee, never resurrect an item the user completed or deleted — keep a tombstone row with `done` or `deleted` marker); `todo.remove.request` deletes the open item with that key; `item.readLater` creates a `deadline` item with `url`, owner = publishing user when known, else all admins; every change publishes `todo.changed`, pushes snapshots, and re-publishes `todo.day.summary` for affected users.

Snapshot per instance: `{ counts: Record<bucket, number>, items: Array<{id,title,icon,list,due,assigneeName,done,version}> (≤ 12, sorted overdue→today→week), canEdit: boolean }`.

**Tests:** `conflict.test`: `PATCH with old version → 409, item unchanged`; `two concurrent done calls: one wins, one 409`. `requests`: `same sourceKey twice → one item`; `request after user completed it does not recreate`; `remove.request deletes open item only`; `changed due date updates existing item`. `routes`: `stranger cannot patch private item (404)`; `clear-done removes only done items of that list visible to user`.

- [ ] Standard task cycle

### Task T3: Tile and detail

**Files:** `client/{Tile,Detail,ItemRow,ItemEditor,IconPicker}.svelte`; Test `tests/client.test.ts`

Tile: bucket headers with counts, checkboxes (`data-edit`), quick-add field (`data-edit`) that accepts `title @handle !fri` shortcuts — only `@handle` (assign) is parsed. Detail: tabs per list (Week / Month / Deadline / Shopping / Chores), drag to reorder within a list (order stored client-side per list in `store` via `PUT /order`, edit), editor with icon picker (theme icons + emoji), assignee, due, repeat and rotation for chores, quantity for shopping; shopping list has a large-touch "store mode" (full-screen, tap to strike). Items from the calendar show a calendar chip linking to the event.

**Tests:** contract suite; `checkbox calls done with version`; `409 refreshes the row and shows a hint`; `quick add with @dani sets assignee`; `store mode strikes items on tap`.

- [ ] Standard task cycle

---

## Module: `weather` (branch `module/weather`)

**Manifest decisions:** scope `shared`; `multiInstance: true`; tile default 3×2, min 2×1, max 6×4; `staleAfterSec: 5400`; levels `['view']`; jobs: `forecast` (1800 s, whenViewed, instance), `sun` (900 s, always, module); publishes `weather.updated`, `time.sun`; outbound hosts `api.open-meteo.com`, `air-quality-api.open-meteo.com`, `geocoding-api.open-meteo.com`.

Module config (admin): `home: { name: string; lat: number; lon: number }`, `units: 'metric'|'imperial'` (default metric).
Instance settings: `location: {name,lat,lon} | null` (null = home), `show: { pollen: boolean; air: boolean; uv: boolean }` (all true), `pollenTypes: string[]` (default all six).

### Task W1: Mapping and jobs

**Files:** `manifest.ts`, `server/{openmeteo.ts,map.ts,sun.ts,index.ts}`; fixtures `forecast.json`, `air.json`, `geocode.json`; Test `tests/map.test.ts`, `tests/server.test.ts`

```ts
export type Snapshot = { needsSetup?: true; place: string; now: { tempC: number; feelsC: number; condition: Condition; windKph: number; humidity: number };
  nextPrecip: { at: string; mm: number } | null; today: { minC: number; maxC: number; uvMax: number | null; sunrise: string; sunset: string };
  pollen: Array<{ type: string; level: 0|1|2|3|4|5 }>; air: { aqi: number; band: 'good'|'fair'|'moderate'|'poor'|'very-poor' } | null };
export function conditionFromWmo(code: number): Condition;
export function pollenLevel(type: string, grainsPerM3: number): 0|1|2|3|4|5;
export function sunAltitudeDeg(lat: number, lon: number, at: Date): number;
```
Rules: WMO codes → condition: `0,1 clear · 2,3 cloudy · 45,48 fog · 51–57 drizzle · 61–67,80–82 rain · 71–77,85,86 snow · 95–99 storm`. Pollen thresholds (grains/m³ → level 1…5): tree pollen (alder, birch, olive) `>0, >10, >50, >200, >700`; grass, mugwort, ragweed `>0, >5, >20, >50, >150`; kept in one table constant. AQI = European AQI; bands at `20, 40, 60, 80`. `nextPrecip` = first hour in the next 24 h with ≥ 0.2 mm. Requests use `ttlSec: 1500` so instances sharing a location share one upstream call. `weather.updated` and `time.sun` are published only for the **home** location. `sun` job computes sunrise/sunset locally (no network) and publishes `time.sun` when `isDay` flips and at startup. Geocoding route: `GET /geocode?q` (view) → up to 5 places. Detail route: `GET /detail?instanceId` (view) → hourly 48 h (temp, precip, wind), daily 7 d, pollen per type per day, AQI components.

**Tests:** `maps forecast.json to exact snapshot values`; `each WMO group maps as specified`; `pollen thresholds at boundaries (10 → 1, 11 → 2)`; `nextPrecip null when dry`; `missing home config → needsSetup snapshot, no request`; `weather.updated only for home`; `time.sun published on flip, not on every run`; `two instances same location → one upstream request`; contract suite.

- [ ] Standard task cycle

### Task W2: Tile and detail

**Files:** `client/{Tile,Detail,ConditionIcon,PollenBar}.svelte`; Test `tests/client.test.ts`

Tile: temperature, condition icon, min/max, next rain line, worst pollen, AQI band chip; min size: temperature + icon only. Detail: 48 h chart (temperature line + precipitation bars), 7-day list, pollen by type as 0–5 bars, AQI with components, sunrise/sunset and UV; location search in settings (custom `Settings.svelte`) using `/geocode`.

**Tests:** contract suite; `needsSetup tile shows setup hint`; `imperial units convert 20 °C to 68 °F`; `pollen section hidden when show.pollen false`.

- [ ] Standard task cycle

---

## Module: `briefing` (branch `module/briefing`)

**Manifest decisions:** scope `user`; `multiInstance: false`; tile default 6×2, min 3×1, max 12×4; levels `['view']`; jobs: `compose` (60 s, whenViewed, module); publishes none; subscribes `calendar.day.summary`, `calendar.event.upcoming`, `todo.day.summary`, `weather.updated`, `pin.request`, `notification.created`, `net.connectivity.changed`, `nas.health.changed`; outbound `[]`.

### Task R1: State, composition, tile

**Files:** `manifest.ts`, `server/{state.ts,compose.ts,index.ts}`, `client/{Tile,Detail}.svelte`; Test `tests/compose.test.ts`, `tests/client.test.ts`

```ts
export type Snapshot = { greeting: 'morning'|'day'|'evening'|'night'; date: string;
  next: { title: string; start: string; minutesUntil: number } | null; eventsToday: number;
  todos: { due: Array<{ title: string; list: string }>; overdue: number };
  weatherHint: { key: 'rainAt'|'dry'|'hot'|'frost'|'storm'|'pollenHigh'; vars: Record<string, string|number> } | null;
  pins: Array<{ title: string }>; alerts: Array<{ level: 'warn'|'critical'; title: string }> };
export function compose(state: UserState, now: Date, tz: string): Snapshot;
```
Rules: per-user state kept in `store` (last summaries, last weather, pins by date, unread warn/critical notifications from the last 24 h, max 5); each handler updates state and pushes that user's snapshot; pins expire at the end of their date; weather hint priority: storm > rainAt (next precip within 12 h) > frost (min ≤ 0) > hot (max ≥ 30) > pollenHigh (≥ 4) > dry; greeting by local hour (5–11, 11–17, 17–22, else night); works with any subset of source modules missing (sections simply absent). Detail: full agenda for today and tomorrow, all due todos, alerts with links.

**Tests:** `composes full snapshot from sample state with exact values`; `works with only weather known`; `pin disappears next day`; `hint priority storm over rain`; `user A's summary never appears in user B's snapshot`; contract suites.

- [ ] Standard task cycle

---

## Module: `notifications` (branch `module/notifications`)

**Manifest decisions:** scope `user`; `multiInstance: false`; tile default 3×2, min 2×1, max 6×6; levels `['view']`; jobs none; subscribes `notification.created`; outbound `[]`. Uses the privileged `host.notifications` service (allow-listed for this module id).

### Task N1: Center

**Files:** `manifest.ts`, `server/index.ts`, `client/{Tile,Detail}.svelte`; Test `tests/server.test.ts`, `tests/client.test.ts`

```ts
export type Snapshot = { unread: number; latest: Array<{ id: string; level: string; title: string; moduleId: string; createdAt: string }> };   // ≤ 5
```
Routes: `GET /list?before&unreadOnly&moduleId` (view) → page of 50; `POST /read` (view — reading state is the user's own; list in the suite's `viewWrites`) `{ids | 'all'}`; `GET /mutes`, `PUT /mutes` (view, own) `{moduleId, until: string | 'forever' | null}`.
Rules: on `notification.created` for a user → push that user's snapshot; muted modules' notifications are stored but do not count as unread and are not forwarded to push sinks (mute state exposed to core through `host.notifications.setMutes`). Tile: unread count and latest three with level colour; detail: grouped by day, filter by module and level, mark all read, mute menu per module.

**Tests:** `snapshot unread count follows created and read`; `user only sees own notifications`; `muted module does not raise unread`; `mark all read`; contract suites.

- [ ] Standard task cycle
