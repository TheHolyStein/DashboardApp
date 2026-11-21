# Briefing (`briefing`)

TODO: what this module shows, where its data comes from, which settings it has.

- `manifest.ts`: id, tile sizes, jobs, events, outbound hosts. Imported by server and client.
- `server/index.ts`: migrations, jobs, routes, event handlers.
- `client/`: `Tile.svelte` (dashboard tile) and `Detail.svelte` (opened view).
- `fixtures/`: recorded API responses and tile data used by tests (no live network).
- `tests/`: contract suites from `@dash/module-kit/testing` and `@dash/module-kit/client` (production files import only the light `@dash/module-kit`). Run `pnpm --filter @dash/module-briefing test`.

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

