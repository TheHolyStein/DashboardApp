# Clock (`clock`)

Shows the time in any time zone, the owner's countdown timers and the next calendar event. Multi-instance, per user. No outbound requests.

## Settings (per instance)

| Key | Default | Meaning |
|---|---|---|
| `face` | `''` | Clock face id; empty = theme default |
| `timeZone` | `''` | IANA zone; empty = the viewer's zone |
| `label` | `''` | Caption (max 40 chars) |
| `showSeconds` | `false` | |
| `hour12` | `false` | |
| `showDate` | `true` | |
| `showNextEvent` | `true` | Show the next calendar event |

## Snapshot

Pushed per instance (timers and the next event belong to the instance owner):
`{ timers: [{ id, label, endsAt, durationSec }], nextEvent: { title, start } | null }`.
A snapshot is pushed only when its content changed; every instance gets one on startup (first tick) and when it is added. **Shared pages:** the snapshot belongs to the instance owner, so everyone who can view a shared page sees the owner's running timers and next event; the world-clock list stays private to its user.

## Timers

- Table `m_clock_timers`; created with `POST /timers`, listed with `GET /timers`, removed with `DELETE /timers/:id` (owner only, else 404).
- Limits: duration 1 to 86400 seconds (integer); label trimmed, at most 40 characters; at most 50 running timers per owner (the 51st is refused with 422 `invalid`); at most 12 world-clock zones; at most 20 timers appear in the snapshot (soonest first). Fired rows are deleted after one day (checked at most once an hour).
- Job `tick` (every 5 s) fires due timers: marks the row fired, publishes `timer.finished` `{ id, label }` and notifies the owner (`titleKey: m.clock.notify.finished`, `vars: { label }`, English `title` as fallback; `dedupeKey: timer:<id>`). A failing publish or notification for one timer is logged and does not stop the others. An idle tick (nothing due, no stored next event) does no store scan and no `instances()` call. A timer is therefore announced up to 5 s after its end.

## Events

- Publishes `timer.finished`.
- Handles `calendar.event.upcoming`: keeps, per listed user, the soonest upcoming event (`store` key `next:<userId>`); an event whose start has passed is dropped at the next tick.

## Routes

| Route | Level |
|---|---|
| `GET /timers` | view |
| `POST /timers` `{ label, durationSec }` | edit |
| `DELETE /timers/:id` | edit |
| `GET /zones` | view |
| `PUT /zones` `{ zones: string[] }` | edit |

`/zones` is the caller's own world-clock list (`store` key `zones:<userId>`, empty by default). `PUT` takes at most 12 entries, each a name from `Intl.supportedValuesOf('timeZone')` or `UTC`; duplicates are dropped (order kept); anything else is 422 `invalid`.

## Client

- **Tile**: the theme's clock face (`face` setting, else the theme default; resolved through the shell's `dash:theme` context `clockFace(id)`, falling back to the theme default and then to a built-in digital readout). Below it: the date (`showDate`), the next event with a countdown ("in 25 min", "in 2 h", "now"; `showNextEvent`) and up to two running timers with "+n" for more. At the minimum size (2x1) only the face and its label are shown. There is no needs-setup state: the clock needs no configuration and shows the time even before the first snapshot.
- **Accessibility**: the tile exposes the time once, as the theme face's `role="img"` label or as the built-in readout's text (invisible but present while the face loads, reserving its space). It opens the detail pane through the shell's tile frame; the tile itself has no interactive content.
- **Locale**: dates and times use the browser's locale (the shell does not pass the saved locale to modules yet); an unknown stored time zone renders in UTC.
- **Time source**: `useNow` re-arms one timeout to the next minute boundary (next second when `showSeconds` is on or a timer is running), pauses while the document is hidden and re-syncs when visible.
- **Detail**: world clocks (add/remove at level `edit`), timers (create with label, minutes and seconds; cancel) and a stopwatch (start, stop, lap, reset; local to the pane, not saved). Controls that change stored data carry `data-edit` and are absent at level `view`.
