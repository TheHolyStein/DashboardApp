# Home Dashboard

A modular, themeable, multi-user home dashboard for a headless Fujitsu Futro S7010, reached from phones and PCs over Tailscale. One TypeScript pnpm monorepo: a single Node process (Fastify + SQLite) hosts self-contained modules (manifest, server jobs/routes, Svelte tile/detail components); a Svelte SPA shell renders user-defined pages of tiles; themes are self-contained folders that restyle everything. Modules talk only through a typed event bus.

- Spec: `docs/superpowers/specs/2026-11-12-home-dashboard-design.md`
- Master plan: `docs/superpowers/plans/2026-11-12-dashboard-00-master.md`

## Global Constraints

- **Languages/runtime:** Node 24 LTS; TypeScript `strict: true`, `noUncheckedIndexedAccess: true`; ES modules only.
- **Package scope:** `@dash/*`. Package manager: pnpm; lockfile committed; `--frozen-lockfile` in CI and install script.
- **Import boundaries (lint-enforced):** modules import only `@dash/contract`, `@dash/module-kit`, `@dash/ui`, and their own files. Modules never import other modules or `apps/*`. Themes import only `@dash/contract`, `@dash/ui`, and their own files.
- **Module ids / theme ids:** match `/^[a-z][a-z0-9-]{1,31}$/`. Module tables are prefixed `m_<id with - replaced by _>_`.
- **Network:** the server process binds `127.0.0.1` only. Browsers never call external services. Server-side outbound requests go only through `host.http`.
- **No remote code:** no runtime module install, no third-party scripts/fonts/styles loaded by the browser, strict CSP (`default-src 'self'`; no `unsafe-inline` for scripts).
- **Permissions:** every module route declares a level (`view` or `edit`); the server enforces it. Client-side hiding is never the protection.
- **Secrets:** only through `host.secrets`; never in snapshots, logs, settings, or API responses.
- **Untrusted content:** all HTML from feeds/APIs sanitized server-side before storage; images fetched, re-encoded and served by the server.
- **Shell commands:** only the launcher runs external commands, only from `launcher.yaml`, never from request input.
- **Time:** store UTC ISO-8601 or epoch ms; display in the user's time zone; server TZ is UTC. Inject time via `host.now()`; never call `Date.now()` in module logic.
- **Tests:** Vitest; no live network (use `fixtures/`); deterministic time.
- **Performance budgets:** server RSS < 200 MB at rest; idle CPU < 2 %; shell JS < 150 KB gzip; each module client chunk < 60 KB gzip (charts excluded, shared); dashboard interactive < 2 s on a mid-range phone.
- **Accessibility:** keyboard reachable; visible focus; text contrast ≥ 4.5:1 in every theme and mode; honors `prefers-reduced-motion`.
- **Languages of UI:** English strings as keys' fallbacks; all user-visible text goes through `t(key, fallback)` so themes and a later German locale can replace it.
- **Licences:** dependencies MIT/ISC/BSD/Apache-2.0/MPL-2.0 only (MPL-2.0 is needed for `ical.js`).

## Ownership

Each work item has its own branch and may modify only the listed paths. Touching anything else is a defect. Shared files (root `package.json`, lockfile, `packages/contract/**`, `packages/module-kit/**`) change only through the orchestrator.

| Work | Branch | May modify only |
|---|---|---|
| Core track A | `track/server-core` | `apps/server/src/core/**`, `apps/server/src/main.ts`, `apps/server/test/core/**` |
| Core track B | `track/auth` | `apps/server/src/auth/**`, `apps/server/test/auth/**` |
| Core track C | `track/web-shell` | `apps/web/src/shell/**`, `apps/web/src/lib/**`, `apps/web/test/shell/**`, `packages/ui/**` |
| Core track D | `track/theme-engine` | `apps/web/src/theme/**`, `apps/web/test/theme/**`, `themes/default/**` |
| Core track E | `track/deploy` | `deploy/**`, `config/**`, `docs/ops/**` |
| Module | `module/<id>` | `modules/<id>/**` |
| Theme | `theme/<id>` | `themes/<id>/**` |
| Cross-cutting | `feature/<name>` | paths listed in plan 08 per task |

## Root commands

| Command | Does |
|---|---|
| `pnpm dev` | server + web in watch mode against `./.data` |
| `pnpm check` | lint + typecheck + unit tests + contract suites + bundle budget |
| `pnpm test` | unit tests only |
| `pnpm --filter @dash/module-<id> test` | one module's tests |
| `pnpm build` | production build of server and web |
| `pnpm e2e` | Playwright end-to-end |
| `pnpm gen` | regenerate module/theme registries |
| `pnpm new:module <id>` / `pnpm new:theme <id>` | scaffold from template |
