# Todo (`todo`)

Week, month and deadline tasks, a shopping list and repeating chores with rotation, shared by the household. The data
is the module's own SQLite table `m_todo_items`; nothing is fetched from the network.

## What it shows

- **Tile** (3x4, min 2x2): counts and items per bucket (overdue, today, this week, this month, later, no date), a
  checkbox per item and a quick-add field. `title @handle` assigns the item; only `@handle` is parsed.
- **Detail**: one tab per list (Week, Month, Deadline, Shopping, Chores), an editor (icon, note, due date, assignee,
  visibility, quantity for shopping, repeat and rotation for chores), reordering by drag or with the move buttons, "Clear
  done", and a full-screen **store mode** for the shopping list (big targets, tap to strike, tap again to undo).

## Instance settings

`lists` (default all five), `show` (`mine` = items not assigned to somebody else, or `all`), `hideDone` (default true).
Settings only shape the tile snapshot; the detail pane has its own tabs.

## Rules

- Shopping and chores default to shared, the other lists to private. A private item is visible to its owner and its
  assignee; anybody else gets 404 (not 403) from every item route, so existence does not leak.
- `week` / `month` items without a due date get one at the end of the current ISO week (Sunday 23:59 local) or month.
  A bare `YYYY-MM-DD` due date means 23:59 local that day. The server learns a user's time zone from the `timeZone`
  field the client sends with its calls (default UTC until then).
- Every item has a `version`. `PATCH`, `done` and `DELETE` carry it; the check and the bump are one SQL statement
  (`UPDATE ... WHERE id = ? AND version = ?`), a mismatch answers 409 with the current item in `details.item`.
- Completing a repeating chore creates the next occurrence (`due + every x unit`, assigned to the next person in the
  rotation).

## Routes

`GET /items?list&show&timeZone` (view), `GET /users` (view), `POST /items`, `PATCH /items/:id`, `POST /items/:id/done`,
`DELETE /items/:id` (version in the body or `?version=`), `POST /items/clear-done`, `PUT /order` (the caller's own order
of one list, stored in `host.store`; not a data change, so no new `rev`). All except the two `GET`s are `edit`.
Every items answer is `{ epoch, rev, userId, items, order }`; clients apply it when the epoch differs or `rev` is at
least what they hold.

## Events

Publishes `todo.changed` (per item) and `todo.day.summary` (per user, only when it changed; an empty one only to clear a
non-empty one). Subscribes to `todo.create.request` (upsert by `sourceKey`; an item the user completed or deleted keeps a
tombstone row and is never recreated), `todo.remove.request` (deletes the open item with that key) and `item.readLater`
(a shared `deadline` item with the link, once per URL).

The `rollover` job (every 15 min) rebuilds snapshots and day summaries as time moves buckets, and drops done items
older than 30 days (request items stay as tombstones).

## Files

- `manifest.ts`: settings and the wire types. `server/migrations.ts`: the table (`modified_at`, not `updated_at`, see the
  comment there). `server/items.ts`, `server/buckets.ts`, `server/requests.ts`, `server/snapshot.ts`, `server/index.ts`.
- `client/`: `Tile`, `Detail`, `ItemRow`, `ItemEditor`, `IconPicker`, `StoreMode`, plus `model.ts` and `format.ts`.
- `fixtures/`: `tile.json` and `detail.json` (snapshot shaped). `tests/`: contract suites and the module's own tests.

## Shared pages

A snapshot is built from the instance owner's point of view and every viewer of the page sees it, including the owner's
private items. Viewers who are not the owner see it read-only and never call the item routes.
