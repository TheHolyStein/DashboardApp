# Calendar (`calendar`)

Shared calendars with recurring events, read-only ICS subscriptions, reminders and commands written into event titles.
Events are stored as raw ICS (the source of truth, ready for CalDAV in plan 08); indexed columns are derived from it.

**Tile:** today's remaining events, then the next days (≤ 8 within `daysAhead`), grouped Today / Tomorrow / date; at
min size only the next event. **Detail:** agenda, day, week (3 days on phones) and month views, calendar filter, editor
with repeat picker and live command chips; drag to move or resize (15-minute steps).

**Settings:** `calendarIds` (empty = all visible), `defaultView`, `weekStart`, `daysAhead`. **Config:**
`defaultReminderMin`, `deriveHorizonDays`.

**API:** `GET /calendars`, `POST /calendars`, `PATCH|DELETE /calendars/:id`, `PUT /calendars/:id/shares`,
`GET /events?from&to&calendarIds`, `POST /events`, `PUT /events/:uid` (`etag`, `scope: all|this|future`,
`occurrenceStart`), `POST /events/:uid/delete` (the client's way; `DELETE /events/:uid` takes the fields as query),
`POST /subscriptions`, `DELETE /subscriptions/:id`. A stale `etag` answers 409 with the current event in `details`.

**Commands** (title or description): `@handle` (deadline todo), `#shopping a, b`, `#chore`, `!remind 30m|2h|1d`,
`!prep 2d`, `!countdown`, `!pin`, `!wled [target:]preset`, `#private` (only the creator sees it), `#outdoor`,
`#birthday [year]`. The `derive` job reconciles them into requests to other modules by `sourceKey`
(`calendar:<uid>:<occurrence|single>:<kind>:<hash>`); bookkeeping is committed before publishing.

**Privacy:** private events never go into tile snapshots (the page may be shared) and are hidden from everyone but
their creator in `GET /events` and day summaries.

- `manifest.ts`: id, tile sizes, jobs, events, outbound hosts. Imported by server and client.
- `server/index.ts`: migrations, jobs, routes, event handlers.
- `client/`: `Tile.svelte` (dashboard tile) and `Detail.svelte` (opened view).
- `fixtures/`: recorded API responses and tile data used by tests (no live network).
- `tests/`: contract suites from `@dash/module-kit/testing` and `@dash/module-kit/client` (production files import only the light `@dash/module-kit`). Run `pnpm --filter @dash/module-calendar test`.

Rules: import only `@dash/contract`, `@dash/module-kit`, `@dash/ui` and your own files; every visible string goes
through `t(key, fallback)`; every mutating element carries `data-edit`; time comes from `host.now()`.

## Conventions this template follows (contract v2)

- i18n keys are `m.<id>.*`; formatted numbers, times and dates go in `<span data-value>` instead of a `t()` placeholder.
- `newId(host.now())` for ids, `createSnapshotPusher(host)` to push a snapshot only when it changed.
- Route bodies and queries are typed: `body: Schema` gives `req.body` as `z.infer<typeof Schema>`; handlers may return a value, a promise, or `undefined` (204).
- One migration may create a table and its index. The table prefix is `m_<id with - as _>_`.
- The shell makes the whole tile (and its title button) open `Detail.svelte`; set `detail: false` in `client/index.ts` to opt out.

## Shared pages show the owner's data

A page can be shared. Everyone who may view a shared page sees the snapshots of the instances on it, and those snapshots are
produced from the owner's settings and secrets. Put only what the owner is willing to show every viewer into a snapshot, never
tokens or private details, and do not return the owner's data from a `view` route for someone who is not allowed to see the page.

