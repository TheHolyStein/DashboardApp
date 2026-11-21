# Notifications (`notifications`)

The notification centre. The tile shows the user's unread count and the newest unread notifications with their level; the
detail pane lists the history grouped by day (filter by module, level and unread, mark read, load more) and has a mute
menu per module.

The notifications themselves live in core. This module uses the privileged `host.notifications` service, which core only
hands to module ids on its allow-list (`PRIVILEGED` in `apps/server/src/core/notifications.ts`; today: `notifications`).
Without it the routes answer 500 and snapshots are not updated; the module still loads.

## Snapshot

`{ epoch, rev, unread, latest[≤5] }` per user, pushed to each of that user's instances when `notification.created`
arrives, or when the user marks read or changes a mute. `unread` leaves out muted modules; `latest` are the newest
**unread** notifications of modules that are not muted. Core stores a muted module's notifications already read and
publishes no event for them (so they never raise the count and never reach push sinks); mutes set later also take a
module's earlier unread notifications out of the count (counted up to 100 per muted module).

## Routes (all `view`: they only touch the caller's own state)

| Route | Purpose |
|---|---|
| `GET /list?before&unreadOnly&moduleId` | page of 50, newest first; `next` is the next `before` cursor |
| `POST /read` `{ ids: string[] \| 'all' }` | mark read; answers `{ epoch, rev, unread }` |
| `GET /mutes` | active mutes `{ moduleId: ISO time \| 'forever' }` |
| `PUT /mutes` `{ moduleId, until: ISO future time \| 'forever' \| null }` | set or remove a mute (the service is core's `setMute`) |

`POST /read` and `PUT /mutes` are listed in the server suite's `viewWrites`.

## Limits

- A timed mute that runs out is noticed at the next push or when the pane reloads: the module has no job (per plan).
- Paging uses `created_at < before`; two notifications created in the same millisecond at a page boundary can be skipped.
- The mute menu offers the modules that have sent the user a notification (plus muted ones).

## Files

- `manifest.ts`: id, tile sizes, event, snapshot and response types.
- `server/index.ts`: handler, routes, setup (revisions, epoch).
- `client/`: `Tile.svelte`, `Detail.svelte`, `format.ts`.
- `tests/`: `server.test.ts`, `client.test.ts`, `fake-notifications.ts` (in-memory stand-in for the privileged service, same semantics as core's). Run `pnpm --filter @dash/module-notifications test`.
