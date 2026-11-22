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
  A bare `YYYY-MM-DD` due date means 23:59 local that day. Time zones come from `host.users()` (the user's saved
  zone); the client sends none. A snapshot carries the zone it was computed in and the tile groups in that zone.
- Every item has a `version`. `PATCH`, `done` and `DELETE` carry it; the check and the bump are one SQL statement
  (`UPDATE ... WHERE id = ? AND version = ?`), a mismatch answers 409 with the current item in `details.item`.
- Completing a repeating chore creates the next occurrence (`due + every x unit`, assigned to the next person in the
  rotation). Undoing it deletes the next occurrence again when it is still open and untouched (`spawned_id`); a touched one
  stays and completing again spawns nothing. Rotation members must be known users (422). A monthly chore keeps its anchor day.

## Routes

`GET /items?list&show` (view), `GET /users` (view), `POST /items`, `PATCH /items/:id`, `POST /items/:id/done`,
`DELETE /items/:id` (version in the body or `?version=`), `POST /items/clear-done`, `PUT /order` (the caller's own order
of one list, stored in `host.store`; raises `rev` so the answer is newer than what the client holds, pushes nothing). All except the two `GET`s are `edit`.
Every items answer is `{ epoch, rev, userId, items, order }`; clients apply it when the epoch differs or `rev` is at
least what they hold.

## Events

Publishes `todo.changed` (per item) and `todo.day.summary` (per user, only when it changed; an empty one only to clear a
non-empty one). Subscribes to `todo.create.request` (upsert by `(owner, sourceKey)`; `ownerId` null/absent = shared household item, `visibility` absent = the list default; a re-emitted request only applies fields it changed; an item the user completed or deleted keeps a
tombstone row and is never recreated), `todo.remove.request` (deletes the open items with that key, any owner) and `item.readLater`
(a private `deadline` item with the link, once per URL, for `userId` or for every admin when absent).

The `rollover` job (every 15 min) rebuilds snapshots and day summaries as time moves buckets, and drops done items
older than 30 days (request items stay as tombstones).

## Files

- `manifest.ts`: settings and the wire types. `server/migrations.ts`: the table. `server/items.ts`, `server/buckets.ts`, `server/requests.ts`, `server/snapshot.ts`, `server/index.ts`.
- `client/`: `Tile`, `Detail`, `ItemRow`, `ItemEditor`, `IconPicker`, `StoreMode`, plus `model.ts` and `format.ts`.
- `fixtures/`: `tile.json` and `detail.json` (snapshot shaped). `tests/`: contract suites and the module's own tests.

## Shared pages

A snapshot is built from the instance owner's point of view and every viewer of the page sees it, including the owner's
private items. Viewers who are not the owner see it read-only and never call the item routes.
