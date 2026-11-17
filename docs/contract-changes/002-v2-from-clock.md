# Contract change 002: v2, from the Clock slice

`CONTRACT_VERSION` 1 to 2. All changes are additive: existing names keep compiling. Tag: `contract-v2`.

Format per change: problem / change / who is affected / migration for existing code (only Clock exists today).

## Kit (`@dash/module-kit`)

### A1. Mock `applyMigrations` runs several statements
- Problem: the mock ran one statement per migration (`prepare`), the real runner uses `db.exec`. A table plus its index in one migration passed in production and threw in tests; Clock split its migration in two.
- Change: `applyMigrations` runs each migration with `exec`, like `migrateModule`.
- Affected: every module with migrations; tests only.
- Migration: Clock may merge its two migrations into one (it has not shipped).

### A2. Mock router answers 204 for `undefined`
- Problem: a handler returning `undefined` gave `{ status: 200, body: undefined }` in the mock and 204 in the real router.
- Change: the mock router returns `{ status: 204, body: undefined }`.
- Affected: route tests asserting 200 for delete-style handlers.
- Migration: assert 204.

### A3. `createSnapshotPusher(host)`
- Problem: every module re-implemented "push only when changed" (Clock used a module-level `WeakMap`).
- Change: `createSnapshotPusher(host)` from `@dash/module-kit` returns `{ push(instanceId | null, data): boolean, forget(id), forgetAll() }`. The state lives in the returned object.
- Affected: modules that dedupe pushes.
- Migration: replace the `WeakMap`; call `forget(instance.id)` in `onInstanceChange('removed')`.

### A4. `newId(now?)`
- Problem: ids are documented as uuid v7 but modules only had `crypto.randomUUID()` (v4).
- Change: `newId(host.now())` returns a time-ordered uuid v7 (Web Crypto, works in server and browser).
- Affected: modules creating rows with ids.
- Migration: replace `crypto.randomUUID()`.

### A5. Client suite `t` honours `vars`
- Problem: the suite's identity `t` ignored `vars`, so renders showed `in {n} min` literally.
- Change: the identity translator interpolates `{name}`; the marking translator is unchanged.
- Affected: client contract suite users; no code change needed.

### A6. `@dash/ui` brings its uPlot stylesheet declaration
- Problem: any module importing `@dash/ui` failed `tsc` with TS2307 unless it declared `uplot/dist/uPlot.min.css`.
- Change: `packages/ui/src/index.ts` references `css-modules.d.ts`, so the declaration travels with the package.
- Affected: all modules.
- Migration: delete the `declare module 'uplot/dist/uPlot.min.css'` line from `modules/clock/env.d.ts` (done).

### A7. `data-value` in the client suite
- Problem: formatted numbers, times and dates had to be wrapped in placeholder `t('m.x.value', '{value}', …)` calls to pass "all visible text goes through t()".
- Change: text inside an element with the attribute `data-value` is data and exempt. Text without it is still checked.
- Affected: modules that rendered formatted values via placeholder keys.
- Migration: render `<span data-value>{formatted}</span>` and drop the placeholder keys.

### A10. Clock faces expose the time as text
- Problem: the Default analog face was an SVG with only the label as accessible name.
- Change: the theme suite case `each clock face renders at 2×1 and 6×4` also requires hour and minute as visible text, or `role="img"` with an `aria-label` containing them. The Default Analog face now labels itself `"<label>, HH:MM"`.
- Affected: theme authors with clock faces.
- Migration: add the time to the face's `aria-label` (or show it as text).

## Contract (`@dash/contract`)

### B1. Typed route bodies and queries
- Problem: `RouteRequest.body` was `unknown` even with a Zod `body` schema; handlers re-parsed or cast, and had to return promises.
- Change: `RouteOptions<B, Q>` (`body?: z.ZodType<B>`, `query?: z.ZodType<Q>`), `RouteHandler<B, Q>`, and `ModuleRouter.get/post/put/patch/delete<B, Q>`. Handlers may return a value or a promise. The real router and the mock router accept sync returns.
- Affected: all route registrations; untyped use still compiles.
- Migration: drop the manual parse/cast and the `Promise.resolve` wrapper; Clock uses its Zod schema as `body`.

### B2. Theme seam and context keys in the contract
- Problem: `ThemeSeam` and the keys `dash:theme`, `dash:t`, `dash:icons` lived in `apps/web` or as string literals in modules.
- Change: `THEME_CONTEXT_KEY`, `T_CONTEXT_KEY`, `ICONS_CONTEXT_KEY` and `ThemeSeam` are exported from `@dash/contract`. `@dash/ui` (`T_KEY`, `ICONS_KEY`, the chart) and the shell use them; `apps/web/src/lib/host.ts` still re-exports `THEME_KEY` and `ThemeSeam` for existing importers.
- Affected: Clock's tile (local seam type and string literal), anything reading the theme context.
- Migration: import the key and type from `@dash/contract`.

### B3. Notification text keys
- Problem: server-side notifications could only carry hard-coded English text.
- Change: `Notification` gains optional `titleKey`, `bodyKey`, `vars`; `NotificationRecord` and `NotificationDto` carry them as nullable fields; one SQL migration (`0006_notification_text_keys.sql`) adds `title_key`, `body_key`, `vars` (JSON text). The server drops keys that are not short `[\w.-]` tokens and limits `vars` to 10 string/number entries (strings up to 200 characters). The shell renders `t(titleKey, title, vars)` and `t(bodyKey, body, vars)`. `title` stays required.
- Affected: `NotificationDto` consumers (the web shell, later the notifications module).
- Migration: Clock sends `titleKey: 'm.clock.notify.finished'`, `vars: { label }`.

### B4. `MeDto.totpEnabled`
- Problem: the Account screen showed both "set up" and "turn off" because the client did not know the TOTP state.
- Change: `MeDto` gains required `totpEnabled: boolean`, filled by the server (`enabled` or `unreadable` is true, a pending set-up is false). The Account screen shows set-up or turn-off.
- Affected: code that builds a `MeDto` (the offline restore in the web app, test fixtures).
- Migration: add `totpEnabled: false` to hand-built values.

### C1. Detail affordance
- Problem: the shell had nothing that opens a detail pane; Clock carried its own overlay button.
- Change: `ModuleClient.detail?: boolean` (default true). `TileHost` opens the pane when the tile frame is clicked (not on links, buttons, inputs, `[role=button]` or `[data-no-open]`, not in edit mode); the tile title becomes a button with `aria-haspopup="dialog"` for keyboard users. `@dash/ui` `Tile` and `TileHeader` get an `onOpen` prop.
- Affected: all tiles.
- Migration: remove the overlay button (Clock); add `detail: false` for tiles without a detail view.

## `@dash/ui`

### A8. `Button busy` and `serial(fn)`
- Problem: modules that mutate lists lost updates on quick repeated clicks and had no busy state.
- Change: `<Button busy>` disables the button and sets `aria-busy="true"` without changing its content or size. `serial(fn)` wraps an async function so calls run one after another, each returning its own promise; a rejected call does not block later ones.
- Affected: modules with mutating handlers.
- Migration: wrap list-mutating handlers in `serial`, pass `busy` while a request runs.

## Tooling

### A9. ESLint `no-unused-vars` in `.svelte`
- Problem: the base rule flagged parameter names inside function type signatures.
- Change: `.svelte` files use `@typescript-eslint/no-unused-vars`; the base rule is off there. A lint-fixture test covers it.
- Affected: all Svelte components.
- Migration: remove `eslint-disable no-unused-vars` comments (Clock's tile).

### D1. Template
- `tools/templates/module` now uses `m.<id>.*` keys, `newId`, `createSnapshotPusher`, typed bodies, a table-plus-index migration, `data-value`, `Button busy`/`serial`, and has a README section "Shared pages show the owner's data". The scaffolder fills a new `__TABLE_PREFIX__` placeholder (`m_<id with - as _>_`).

## v2 completion (KC-3)

Three additive completions made before any module beyond Clock exists. `CONTRACT_VERSION` stays 2.

### E1. `locale` and `timeZone` props
- Problem: modules had no access to the user's locale and time zone and formatted with the browser default.
- Change: `TileProps`, `DetailProps` and `SettingsProps` gain required `locale: string` and `timeZone: string` (the user's `prefs.locale` / `prefs.timeZone`). `TileHost` and `DetailHost` pass them from the session, falling back to `navigator.language` / `Intl.DateTimeFormat().resolvedOptions().timeZone` only when the prefs are empty. The client contract suite renders with `de-DE` and `Asia/Kolkata`.
- Affected: any code that builds `TileProps` / `DetailProps` by hand (tests).
- Migration: use the props in every `Intl` call.

### E2. `ModuleServer.setup` and `teardown`
- Problem: per-host state (snapshot pusher, caches) had no safe place to be created.
- Change: optional `setup?(host)` runs once per loaded, enabled module after migrations and before the first job, route or event handler; a throw or rejection marks the module failed. Optional `teardown?(host)` runs on server shutdown before the database closes (errors logged). `createMockHostWithSetup(server, { now?, prepare? })` in `@dash/module-kit/testing`; `runServerContractSuite` runs `setup` before jobs and routes.
- Affected: modules that keep per-host state.
- Migration: create the pusher in `setup`, hold it in a closure.

### E3. `data-user` marker
- Problem: user-provided text (titles, feed headlines) could only be passed through `data-value`, whose prose guard rejects sentences.
- Change: text inside an element with `data-user` is exempt from the `t()` rule and the `data-value` prose guard in the client contract suite.
- Affected: tiles showing user content.
- Migration: wrap such text in `<span data-user>`.

