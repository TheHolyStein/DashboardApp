# Dashboard 09 — Hardening and Release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify security, performance on the real device, and operability, then tag v1.0.0.

**Architecture:** Review and measurement tasks that produce findings; each finding becomes a failing test plus a fix on a `fix/<slug>` branch, following the standard cycle.

**Tech Stack:** as master plan; Playwright, Lighthouse CI, `autocannon`, `pidstat`, `systemd-analyze`.

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (sections 6, 7, 9, 10)

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply.

## Review Focus

This plan re-verifies all five master Review Focus items end to end on the device (Task R4).

**Parallelism:** R1, R2, R3 can run in parallel (different reviewers). R4–R6 are serial and need the human and the device.

---

### Task R1: Security review (reviewer agent, read-only, then fixes)

**Files:** Create `docs/security/review-v1.md`; fixes on `fix/*` branches

- [ ] Run the `/security-review` skill over the whole repository and record findings.
- [ ] Walk this checklist; each line gets PASS/FAIL with evidence (file:line or test name):
  - Every module route has a level; no route reads another user's private data (grep `r.(get|post|put|patch|delete)(` and inspect handlers for owner checks).
  - No `{@html}` anywhere in `modules/**`, `themes/**`, `apps/web/**` except through a single audited helper (expect none).
  - No `child_process` use outside `apps/server/src/core/launcher` and `deploy/**`; the launcher uses `execFile` with fixed arguments.
  - No `fetch(`/`http.request`/`undici` use in `modules/**` (only `host.http`); lint rule exists and is enforced.
  - No secret values in logs: run the full test suite with secrets set to sentinels and grep captured logs.
  - CSP present and strict on every response type; no third-party origins in built HTML/CSS/JS (grep `https://` in `apps/web/dist`).
  - Session cookie flags; CSRF on all state-changing core and module routes; CalDAV exempt only under Basic auth.
  - Request-forgery guard: re-run A5 tests; add cases for IPv4-mapped IPv6 (`::ffff:10.0.0.1`), decimal/octal IP forms (`http://2130706433/`, `http://0177.0.0.1/`), and a hostname with trailing dot.
  - XML parsers (RSS, CalDAV, ICS): entity expansion disabled, size caps.
  - Image pipeline refuses SVG and non-images; served with `X-Content-Type-Options: nosniff` and a fixed content type.
  - Rate limits on login and on CalDAV Basic auth failures (same lockout store).
  - Dependencies: `pnpm audit --prod` clean at high; licences within the allowed set (`pnpm licenses list`); no dependency with install scripts outside the allow-list.
  - systemd exposure scores recorded; firewall rules match the documented list; server not reachable on the LAN address (`curl` from another LAN host fails).
- [ ] Every FAIL → failing test → fix → PASS. Re-run until the document has no FAIL.
- [ ] Commit `docs/security/review-v1.md`.

### Task R2: Permission matrix end-to-end

**Files:** Create `e2e/permissions.spec.ts`

- [ ] Seed: admin A, member B with grants calendar=edit, todo=edit, weather=view, everything else none; A owns a shared page with calendar, todo, weather, wled, nas.
- [ ] Assert as B: sees calendar/todo/weather tiles only; weather has no edit controls; direct requests to `/api/m/wled/state`, `/api/m/nas/detail`, `/api/admin/users` → 403; stream never delivers wled/nas snapshots (collect 30 s); B's private todo invisible to A in the UI and API; an event with `#private` created by A is invisible to B in the web UI **and** via CalDAV.
- [ ] Assert revocation: A sets B's todo grant to none while B is connected → B's todo tile disappears within 2 s without reload; B's API calls → 403.
- [ ] Standard task cycle for any failure.

### Task R3: Accessibility and theme audit

**Files:** Create `e2e/a11y.spec.ts`, `docs/themes/audit-v1.md`

- [ ] For each theme × mode: run axe on the dashboard, an open detail pane, the settings dialog, and the login page; zero serious/critical violations.
- [ ] Keyboard-only walk: reach every tile, open/close pane, operate edit mode (move a tile with keyboard), sign out.
- [ ] `prefers-reduced-motion`: no scene animation, no pane transform animation, no blinking.
- [ ] Phone width 360 px: no horizontal scroll on any page, pane full-screen, tap targets ≥ 44 px.
- [ ] Record results; fix failures via the standard cycle.

### Task R4: Device performance and resilience (with the human, on the Futro)

**Files:** Update `docs/ops/baseline.md`

All modules enabled, all three themes installed, two users, realistic data (seed script `tools/seed-demo.ts`: 500 events, 300 todos, 30 days of samples).

- [ ] **Idle:** nobody connected for 15 min → server CPU < 2 % (`pidstat 60 15`), RSS < 200 MB.
- [ ] **Viewing:** one phone + one PC on a full page → CPU < 10 % average, RSS < 250 MB.
- [ ] **Load:** `autocannon -c 20 -d 30` against `/api/pages` with a session → p99 < 150 ms, no errors.
- [ ] **Front end:** Lighthouse (mobile preset, over Tailscale) on the dashboard: performance ≥ 85, time to interactive < 2 s on the owner's phone; shell JS and per-module chunk budgets pass in CI.
- [ ] **Scenes:** each theme's `full` scenes on the owner's phone hold ≥ 28 fps or the governor drops intensity within 5 s.
- [ ] **Disk writes:** `iostat` over 1 h idle → < 50 MB written; database size after seeding < 150 MB.
- [ ] **Review Focus #1:** create a weekly 09:00 event; set the server clock context across the next DST change in a test profile; verify 09:00 in UI and on a synced phone.
- [ ] **Review Focus #2:** block outbound internet on the Futro for 10 min (`ufw deny out` on a test rule): tiles show "offline since", no error storms in the journal, CPU stays < 5 %; unblock: all tiles fresh within 2 min, jobs spread out.
- [ ] **Review Focus #3:** edit the same event on the phone calendar app and the web UI within the same sync window → one side gets a conflict, no silent loss.
- [ ] **Review Focus #4:** pull the power plug while adding todos in a loop; boot; `doctor` all OK; `integrity_check` ok; no duplicate derived todos.
- [ ] **Review Focus #5:** phone: lock for 10 min, switch Wi-Fi → mobile data, unlock → tiles current within 5 s without reload.
- [ ] **Launcher:** start the placeholder test app (a tiny static server entry in `launcher.yaml`) → minimal mode on, Open works, back works, stop restores jobs.
- [ ] Record all numbers. Any miss → fix via the standard cycle and re-measure.

### Task R5: Documentation pass

**Files:** `README.md`, `docs/ops/*.md`, `docs/dev/{module-guide,theme-guide,contract}.md`, `CHANGELOG.md`

- [ ] `docs/dev/module-guide.md` and `theme-guide.md`: distilled from plans 03 and 07 playbooks, updated with what changed during the build, each with a 15-minute "hello module/theme" walkthrough that a fresh agent executes successfully (dispatch one to verify; fix the guide where it stumbled).
- [ ] `docs/dev/contract.md`: generated reference of manifest fields, host services, events (script `tools/gen-contract-docs.ts`).
- [ ] Ops docs re-read against reality: setup, update/rollback, second person, calendar sync, launcher, backup/restore, troubleshooting (`doctor` output explained).
- [ ] README: what it is, screenshots of the three themes, quick start for development, link map.

### Task R6: Release

- [ ] `pnpm check && pnpm build && pnpm e2e` green on `main`.
- [ ] Fresh-install rehearsal: wipe a VM or spare disk, follow `docs/ops/setup-guide.md` only, reach a working dashboard. Time it; record in `baseline.md`.
- [ ] Update rehearsal on the Futro: `git pull && sudo ./deploy/install.sh` from v0.x to the release commit with real data; verify pre-migration backup exists; verify rollback instructions by rolling back and forward once.
- [ ] Tag `v1.0.0`, write `CHANGELOG.md`.
- [ ] Hand the owner: tailnet URL, where `secret.key` must be stored, the ops docs index, and the list of open configuration items from spec section 12 (NAS model/credentials, home location, tide point, router adapter, Skills App entry, stock API key).

---

## After v1.0.0 (not planned in detail)

Each is a module or link following plans 03/07 unchanged: `smarthome` (ESP32 sensors: MQTT via a local broker or `POST /api/m/smarthome/ingest` with per-device tokens; publishes `air.threshold`), `departures`, `waste` (ICS subscription with its own tile), `meals`, `fuel`, `energy`, German locale, user-editable automation rules on top of the link framework.
