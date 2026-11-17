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
A snapshot is pushed only when its content changed; every instance gets one on startup (first tick) and when it is added.

## Timers

- Table `m_clock_timers`; created with `POST /timers`, listed with `GET /timers`, removed with `DELETE /timers/:id` (owner only, else 404).
- Limits: duration 1 to 86400 seconds (integer); label trimmed, at most 40 characters; at most 20 timers appear in the snapshot (soonest first).
- Job `tick` (every 5 s) fires due timers: marks the row fired, publishes `timer.finished` `{ id, label }` and notifies the owner (`dedupeKey: timer:<id>`). A timer is therefore announced up to 5 s after its end.

## Events

- Publishes `timer.finished`.
- Handles `calendar.event.upcoming`: keeps, per listed user, the soonest upcoming event (`store` key `next:<userId>`); an event whose start has passed is dropped at the next tick.

## Routes

| Route | Level |
|---|---|
| `GET /timers` | view |
| `POST /timers` `{ label, durationSec }` | edit |
| `DELETE /timers/:id` | edit |
