# __NAME__ (`__ID__`)

TODO: what this module shows, where its data comes from, which settings it has.

- `manifest.ts`: id, tile sizes, jobs, events, outbound hosts. Imported by server and client.
- `server/index.ts`: migrations, jobs, routes, event handlers.
- `client/`: `Tile.svelte` (dashboard tile) and `Detail.svelte` (opened view).
- `fixtures/`: recorded API responses and tile data used by tests (no live network).
- `tests/`: contract suites from `@dash/module-kit/testing` and `@dash/module-kit/client` (production files import only the light `@dash/module-kit`). Run `pnpm --filter @dash/module-__ID__ test`.

Rules: import only `@dash/contract`, `@dash/module-kit`, `@dash/ui` and your own files; every visible string goes
through `t(key, fallback)`; every mutating element carries `data-edit`; time comes from `host.now()`.
