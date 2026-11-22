# Home Dashboard — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modular, themeable, multi-user home dashboard that runs on a headless Fujitsu Futro S7010 and is reached from phones and PCs over Tailscale.

**Architecture:** One TypeScript monorepo. A single Node process (Fastify + SQLite) hosts modules, each a self-contained folder with a manifest, server jobs/routes and Svelte tile/detail components. A Svelte SPA shell renders user-defined pages of tiles; themes are self-contained folders that restyle everything and may override single tiles. Modules talk only through a typed event bus.

**Tech Stack:** Node 24 LTS, TypeScript (strict), pnpm workspaces, Fastify 5, better-sqlite3 + Drizzle, Zod 4, Svelte 5 + Vite, uPlot, gridstack, Vitest, Playwright, Caddy, Tailscale, systemd, Debian stable.

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` — every executor reads it before starting.

## Plan set

| # | File | Phase | Parallel? |
|---|---|---|---|
| 00 | this file | index, rules, constraints | — |
| 01 | `…-01-foundations.md` | Repo, tooling, frozen contracts, mock host | serial, 1 agent |
| 02 | `…-02-core.md` | Server core · Auth · Web shell · Theme engine · Deploy | 5 parallel tracks |
| 03 | `…-03-module-playbook.md` | Reference slice (Clock) + recipe every module agent follows | serial, 1 agent |
| 04 | `…-04-modules-wave1.md` | Calendar, Todo, Weather, Briefing, Notifications | 5 parallel |
| 05 | `…-05-modules-wave2.md` | WLED, Network, NAS, Server health, Pings, Quick links | 6 parallel |
| 06 | `…-06-modules-wave3.md` | RSS, Moon/Tides, Stocks, Daily item, GitHub, Countdowns, Notes, Habits, Focus | 9 parallel |
| 07 | `…-07-themes.md` | Theme recipe + Space, Gloomy, Medieval | 3 parallel |
| 08 | `…-08-cross-cutting.md` | Links, CalDAV, Launcher, Web Push, Backups | 5 parallel |
| 09 | `…-09-release.md` | Security review, device performance, setup guide, v1.0.0 | mostly serial |

All files share the prefix `docs/superpowers/plans/2026-11-12-dashboard`.

## Dependency graph

```
01 Foundations ──► 02 Core (A,B,C,D,E in parallel) ──► 03 Reference slice ──┬─► 04 Wave 1 ─┬─► 08 Cross-cutting ──► 09 Release
                                                                            ├─► 05 Wave 2 ─┤
                                                                            ├─► 06 Wave 3 ─┤
                                                                            └─► 07 Themes ─┘
```

- 04, 05, 06, 07 may all run at once after 03. Waves exist for priority, not dependency: if agent capacity is limited, run 04 first.
- 08 tasks depend on specific modules: Links need the modules they connect; CalDAV needs Calendar (04); Web Push needs Notifications (04). Launcher and Backups need only 02 and can start right after 03.
- 07 theme agents need each module's `fixtures/` only. Themes started before a module exists simply get that module's default tile; overrides are added later.

**Gates (orchestrator stops and verifies before fan-out):**
- **G1 after 01:** `pnpm check` green; contract reviewed by a human. Contract is frozen at `CONTRACT_VERSION = 1`.
- **G2 after 02:** all five tracks merged; app boots; sign-in works; empty page renders in Default theme.
- **G3 after 03:** Clock runs on the real Futro through Tailscale HTTPS. Any contract fix found here lands before fan-out. Bump to `CONTRACT_VERSION = 2` if changed.
- **G4 before 09:** every module and theme passes its contract suite.

## Multi-agent protocol

**Roles.** One *orchestrator* session per phase dispatches *implementer* agents (one per track/module/theme) and a *reviewer* agent per finished branch. The orchestrator never implements; it merges, resolves contract requests, and runs gates.

**Isolation.** Each implementer works in its own git worktree on its own branch:

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

Touching anything else is a defect the reviewer rejects. Shared files (`package.json` at root, lockfile, `packages/contract/**`, `packages/module-kit/**`) change only through the orchestrator.

**Contract change requests.** An implementer who needs a contract change writes `docs/contract-changes/NNN-<slug>.md` (problem, proposed diff, who is affected), commits it on its branch, and reports back `BLOCKED: contract`. The orchestrator decides, applies the change on `main`, bumps `CONTRACT_VERSION`, and tells running agents to rebase. Contract changes are additive unless the orchestrator explicitly approves a break.

**Dependencies.** A new npm dependency is declared in the package/module that needs it. The implementer lists it in its final report with a one-line reason; the reviewer checks licence (see Global Constraints), maintenance, and size.

**Standard task cycle** (every task in every plan follows it; plans list only what is specific):

- [ ] Write the failing test(s) named in the task
- [ ] Run them; confirm they fail for the expected reason
- [ ] Implement the smallest code that satisfies them, using the task's interfaces
- [ ] Run the task's tests; confirm pass
- [ ] Run `pnpm check`; confirm green
- [ ] Commit with a Conventional Commits message scoped to the track/module (`feat(weather): …`)

**Definition of done for a branch.**
1. All task checkboxes ticked.
2. `pnpm check` green (lint incl. import boundaries, typecheck, unit tests, contract suites, bundle budget).
3. No file outside the owned paths changed.
4. No live network call in any test.
5. Final report lists: what was built, new dependencies, deviations from plan, open questions.
6. Reviewer agent approved against the plan and the spec.

**Merge.** Rebase on `main`, squash-merge, delete worktree. Orchestrator runs `pnpm check` on `main` after every merge.

**Suggested concurrency.** Up to 5 implementers during 02, up to 6 at once during 04–07. More than that makes merge and review the bottleneck.

## Global Constraints

Every task's requirements include these.

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

## Review Focus

Conditions the spec implies but that are easy to miss. Each has an owning task that carries a pinning test.

1. **Daylight-saving and time zones.** A weekly 09:00 event must stay at 09:00 local across a DST change; an all-day event must show on the same date for users in different zones. → Plan 04, Calendar task C2 (`recurrence.dst.test.ts`).
2. **External service misbehaves.** An API hangs, returns 500, returns HTML instead of JSON, or returns 50 MB. The tile must show last good data marked stale, the job must back off, nothing crashes. → Plan 02, A5 (`http.limits.test.ts`) and plan 01, F5 contract suite case `job survives bad upstream` (runs against every module).
3. **Two edits at once.** The same event or todo is changed from the web UI and a phone calendar app (or two browsers) at the same moment. The later write must be rejected with a conflict, never silently overwrite. → Plan 04, Calendar C3 (`events.conflict.test.ts`), Todo T2 (`items.conflict.test.ts`); plan 08, CalDAV D3.
4. **Power cut.** The Futro loses power mid-write. On restart the database is intact, jobs resume, and calendar commands do not create duplicate todos. → Plan 02, A1 (`db.crash.test.ts`) and plan 04, Calendar C5 (`commands.idempotent.test.ts`).
5. **Phone sleeps, network changes, internet returns after hours.** The live stream must reconnect by itself, tiles must refresh without a page reload, and all jobs must not fire in the same second when connectivity returns. → Plan 02, C2 (`stream.reconnect.test.ts`) and A4 (`scheduler.recovery.test.ts`).

Also watched, with tests already in their tasks: permission revoked while a user is connected (02 B3/A7), deleted calendar command removes its derived items (04 C5), request-forgery through RSS/ICS URLs (02 A5), feed HTML with scripts (06 RSS).

## Root commands (created in plan 01)

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
