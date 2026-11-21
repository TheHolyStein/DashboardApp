# Briefing (`briefing`)

One tile that sums up the user's day: greeting, next event with a countdown, events and todos due today, a one-line weather
hint, pins for today and up to five alerts. The detail pane lists the full agenda for today and tomorrow, all due todos
and the alerts. The module never calls the network: it only listens to events of other modules and works with any subset
of them missing (a missing source simply leaves its section out).

## Settings

| Key | Meaning |
|---|---|
| `timeZone` | IANA zone (default `UTC`). The server cannot read the user's saved preferences, so this zone decides the greeting and which date is "today". Set it to your own. |

## Events

| Event | Used for | Whose briefing changes |
|---|---|---|
| `calendar.day.summary` | agenda of the day (last summary only) | `userId` |
| `calendar.event.upcoming` | soonest upcoming event | each of `userIds` |
| `todo.day.summary` | due todos, overdue count (last summary only) | `userId` |
| `pin.request` | pins for a date; dropped when the date has passed | each of `userIds` |
| `notification.created` | warn and critical alerts of the last 24 h (max 5) | `userId` |
| `weather.updated` | weather hint (storm > rain within 12 h > frost > hot > pollen > dry) | everyone (household data, no user in the payload) |
| `net.connectivity.changed`, `nas.health.changed` | household alerts while offline / degraded / failed | everyone |

Stored per user in `host.store` (`u:<userId>`): the last calendar and todo summary, the soonest upcoming event, at most 20
pins and 5 alerts. Household state (weather, connectivity, NAS) is one key (`g`). A user's state is deleted when their
instance is removed, and at start for users without an instance.

## Limits

- Frost and heat use the current temperature (`tempC`): the weather event carries no daily minimum or maximum.
- Alert titles for connectivity and NAS conditions are English text from the server (the events carry no translation keys).
- The agenda shows the date of the last `calendar.day.summary` (normally today); tomorrow appears only if a summary for
  tomorrow was the last one received.
- Reading state of notifications is not visible to the briefing: it shows warn and critical notifications of the last 24 h
  whether read or not.

## Files

- `manifest.ts`: id, tile sizes, job, events, settings, snapshot types.
- `server/compose.ts`: the pure `compose(state, now, tz)`; `server/state.ts`: state shape and bounded updates; `server/index.ts`: handlers, job, `GET /day`.
- `client/`: `Tile.svelte`, `Detail.svelte`, `format.ts`.
- `tests/`: `compose.test.ts`, `server.test.ts` (contract suite + handlers), `client.test.ts`. Run `pnpm --filter @dash/module-briefing test`.
