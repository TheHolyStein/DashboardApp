# Home Dashboard — Design

Date: 2026-11-12 · Status: awaiting approval

Legend: **[D]** = decided by the owner in conversation. **[C]** = my call, open to correction.

---

## 1. Intent

A self-hosted home dashboard that guides its owner through the day: what is on today, what is due, what the weather does, what in the house needs attention. It runs on a small headless server at home and is used from phone and PC. A second person in the household gets access to selected parts, mainly a shared calendar and todo lists.

The defining wish: **modules and aesthetics must be easy to add, remove and rearrange.** Everything else serves that.

## 2. Goals, non-goals, anti-goals

**Goals**
- Module system: each module is one self-contained folder. Add, remove, enable, disable, arrange.
- Each module has a compact tile (essentials), a settings dialog (⚙), and a centered detail pane (click).
- Modules refresh their own data on their own schedule, including from the internet and from LAN devices.
- Modules can react to each other without depending on each other.
- Theme system: each aesthetic is one folder. Day and night variant each. Ships with Space, Gloomy, Medieval.
- Multi-user with per-module permissions. Shared calendar that also syncs to native phone calendar apps.
- Reachable from anywhere through a private VPN, never through a public address.
- Light enough for a thin client. Secure enough to hold household data and control house devices.
- Launch other web apps living on the same server (first: the owner's Skills App) and switch back and forth.

**Non-goals**
- No public internet exposure, no public sign-up.
- No runtime installation of third-party modules. Modules arrive through `git pull`.
- No in-browser editing of server shell commands.
- No kiosk/attached-display mode. The server is headless.
- No Google Calendar sync.
- No user-editable automation rule builder in the first release (the event bus makes it possible later).

**Anti-goals** (would make it a failure even if it works)
- Adding a module requires touching core code or other modules.
- Adding a theme requires touching modules.
- A broken or offline module breaks the dashboard or other modules.
- A login bug exposes WLED, NAS or the home network to the internet.
- The dashboard feels sluggish on a phone, or the server sits at high CPU while nobody is looking.

## 3. Constraints

- **Hardware [D]:** Fujitsu Futro S7010 thin client, headless. Low-power Celeron-class CPU, a few GB RAM, small SSD. Exact RAM and disk size unverified; design assumes 4 GB RAM and treats SSD writes as something to limit.
- **OS [D]:** Debian (current stable), minimal install, no desktop.
- **Code updates [D]:** the owner connects over SSH, runs `git pull`, then the install script. Nothing updates code on its own.
- **Remote access [D]:** Tailscale. Mullvad alone cannot do this (no inbound path); it may be added inside Tailscale as an exit-node add-on, which is unrelated to this project.
- **Clients [D]:** phone and PC browsers, for two people.
- **Skills App [D]:** details unknown for now. Treated as a placeholder entry in a generic, configurable app launcher.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **1 ✔** | **One TypeScript app**: Node backend + SQLite + Svelte frontend, one process | One language end to end, so a module lives in one folder and is built by one agent. Node is needed for the Skills App anyway. Slightly thinner SNMP/network libraries than Python. |
| 2 | Python (FastAPI) backend + Svelte frontend | Best device/network/astronomy libraries, but every module is split across two languages and toolchains; more coordination and contract drift. |
| 3 | Home Assistant as engine + custom frontend | Device integrations for free, but ~1 GB RAM, calendar/todo/permissions/themes still custom, and the module system is no longer ours. |

Dropped early: Go/Rust single binary (lightest, slowest to write modules for), existing dashboards such as Homepage or Dashy (no shared calendar, no per-user permissions, shallow theming).

**Picked: 1 [D].** It serves "easy to add modules and aesthetics" best and gives the cleanest parallel work: once the core exists, every module and every theme is an independent task.

## 5. Architecture

### 5.1 Stack [C]

- **Runtime:** Node.js current LTS, TypeScript strict everywhere.
- **Repo:** pnpm workspace monorepo.
- **Server:** Fastify. One process. In-process scheduler and event bus.
- **Database:** SQLite (better-sqlite3, WAL mode) with Drizzle for schema and migrations. One file.
- **Frontend:** Svelte 5 + Vite, built to static files and served by the same server. Single-page app, installable as a PWA. No server-side rendering.
- **Live updates:** one Server-Sent Events stream per client, carrying updates for all subscribed modules.
- **Validation:** Zod schemas shared between server and client; module settings forms are generated from them.
- **Charts:** uPlot (small, canvas, fast on phones), wrapped once so themes supply the palette.
- **Grid:** drag-and-resize grid library (gridstack or equivalent), wrapped once.
- **Reverse proxy:** Caddy in front, HTTPS with the certificate Tailscale issues for the machine's tailnet name.

### 5.2 Repository layout

```
apps/
  server/            Fastify app: core services, auth, module host, launcher (CalDAV lives inside the calendar module)
  web/               Svelte shell: pages, grid, pane, settings, theme engine
packages/
  contract/          Module + theme contracts (types, Zod schemas), event catalog
  module-kit/        Helpers for module authors + mock host for tests
  ui/                Shared primitives: Tile, Pane, Chart, Icon, form controls
modules/
  <module-id>/       manifest.ts, server/, client/, fixtures/, tests/
themes/
  <theme-id>/        theme.ts, tokens.css, background/, icons/, clock/, strings/, tiles/
deploy/              install.sh, systemd units, Caddyfile, ufw rules, backup script
config/              launcher.yaml and other server-only config (examples committed)
docs/
```

Modules and themes are discovered at build time by scanning their folders. Adding one = adding a folder. Removing one = deleting it. No registry file to edit.

### 5.3 Module contract

A module is a folder with:

- **`manifest.ts`**: id, display name, version, icon, default and allowed tile sizes, data scope (per user or shared), settings schema (Zod), background jobs (name, interval, run mode), events it publishes and subscribes to, outbound hosts it may contact (allowlist), whether it needs LAN access, permission levels it supports (view / edit).
- **`server/`**: job handlers, API routes (mounted under `/api/m/<id>/`), optional database migrations for its own tables (prefixed `m_<id>_`).
- **`client/`**: `Tile.svelte`, `Detail.svelte`, optional `Settings.svelte` (when the generated form is not enough). Loaded lazily as a separate chunk.
- **`fixtures/`**: recorded sample data for tests and for theme authors.

The host gives each module a narrow set of services and nothing else:

| Service | Purpose |
|---|---|
| `http` | Outbound fetch through the host: allowlist check, timeout, caching (ETag/TTL), backoff, size cap |
| `store` | Namespaced key-value store plus the module's own tables |
| `secrets` | API keys and device passwords, encrypted at rest, never sent to the browser |
| `bus` | Publish and subscribe to typed events |
| `push` | Send new tile/detail data to subscribed clients over SSE |
| `notify` | Raise an alert in the notification center |
| `log` | Structured logging |

**Isolation rules.** Modules never import each other. A job that throws is caught, logged, and retried with backoff; the tile shows "stale since HH:MM". A client component that throws is caught by an error boundary and shows a broken-tile placeholder. A disabled module's jobs do not run and its routes are not mounted.

**Refresh ("modules update themselves").** Each job declares a run mode:
- `always`: runs on schedule regardless (alerts, NAS health, calendar reminders, time-series collection).
- `whenViewed`: runs only while at least one client has that module on screen or had it recently. Nobody looking means no polling.

Intervals get jitter so jobs do not fire together. The browser never calls external services directly.

### 5.4 Event bus and built-in links

Events are typed and listed in `packages/contract`. Links between modules are small subscribers that ship with the core as toggles in settings.

| From | To | Effect |
|---|---|---|
| Sun times (weather) | Theme | Automatic day/night switch |
| Calendar | Clock | Countdown to next event |
| Calendar | WLED | Scene at event start, wake light |
| Weather / pollen | Calendar | Warning on `#outdoor` events |
| Weather | Briefing | "Rain at 16:00" |
| Moon / tides | Calendar | Full moon and low tide overlay |
| NAS health | Todo + alerts | Failing disk creates a todo |
| Network monitor | All modules | Internet down: tiles show stale state, not errors |
| Network monitor | Alerts | Unknown device on WLAN; WLED board offline |
| Air quality sensors | WLED + alerts | CO₂ high: lamp turns red, "ventilate" |
| Stocks | Alerts | Threshold crossed |
| RSS / GitHub repo of the day | Todo | "Read later" |
| Todo chores | Calendar | Chores with deadlines appear as entries |
| Clock timer | WLED | Flash when a timer ends |

### 5.5 Dashboard shell [D: layout B]

- **Pages:** each user creates and names pages (Today, Home, Tech, …). Each page is a free drag-and-resize grid. Pages are personal or shared. On phones, pages are swiped; tiles stack in the order set for the phone layout (stored separately from the desktop layout).
- **Top bar:** page tabs, day/night toggle, edit mode (✎), notification badge, app launcher, user menu.
- **Tile:** header (icon, name, ⚙), body (essentials), footer (freshness). Click on body opens the detail pane.
- **Detail pane:** centered over the dimmed dashboard, closes with ✕, Escape, or click outside. On phones it fills the screen.
- **Settings:** ⚙ on a tile opens that module instance's settings, generated from the manifest schema. Global settings hold users, permissions, themes, links, backups.
- **Edit mode:** drag, resize, add from the module catalog, remove. The same module may be placed more than once with different settings (two clocks, two RSS feeds).
- **Day/night:** manual, follow device, or automatic from local sunrise/sunset.

### 5.6 Theme contract [D: depth C]

A theme is a folder with:

- **`tokens.css`**: colors, fonts, radii, borders, shadows, spacing; one set for day, one for night. Fonts are self-hosted in the theme folder.
- **`strings/`**: the theme's voice. Optional renames for module titles and common labels ("Calendar" → "Chronicle" / "Mission log").
- **`icons/`**: icon set; falls back to the default set for any missing icon.
- **`clock/`**: one or more clock faces.
- **`chart.ts`**: palette and line style for graphs.
- **`pane.ts`**: open/close transition of the detail pane.
- **`background/`**: the background scene (below).
- **`tiles/<module-id>.svelte`** (optional): a full replacement for how a module's tile is drawn.

**Tile overrides keep new modules cheap [C].** Every module ships a default tile built only from theme tokens and shared primitives, so it looks right in every theme with zero extra work. A theme *may* override single tiles for effect (weather as a star chart, as a heraldic shield). An override receives the same data as the default tile and nothing more. Missing override = default tile. So depth C is available everywhere and required nowhere.

**Backgrounds [D: more variation, driven by theme].** A background is a layered scene, not a flat color:
- Each theme ships **several scene variants**. The user picks one per page, or lets them rotate.
- Scenes **react to live inputs** when the relevant modules are enabled: time of day and sun position, current weather, moon phase.
- Every scene has three intensity levels: `full` (animated), `calm` (minimal motion), `static` (single image). The level drops automatically for `prefers-reduced-motion`, low battery, or measured low frame rate.

| Theme | Scene variants | Reacts how |
|---|---|---|
| Space | Deep starfield; nebula; planet orbit; station window | Planet shows the real moon phase; shooting stars at night; storms tint the nebula |
| Gloomy | Fog over moor; bare forest silhouette; rain on glass; overcast city | Fog thickens with humidity; real rain triggers rain; moonlight follows moon phase |
| Medieval | Parchment map; castle hall stone wall; stained glass; scriptorium desk | Day = daylight parchment, night = candle and torch flicker; weather shows through the window |

A fourth, plain **Default** theme (neutral light/dark) ships as the reference implementation and fallback [C].

### 5.7 Users, sign-in, permissions

- Local accounts only. Created by the admin. Roles: `admin`, `member`.
- Passwords hashed with argon2id. Session cookie: HttpOnly, Secure, SameSite=Strict. CSRF protection on state-changing requests. Login rate limiting and lockout. Optional TOTP second factor.
- **Per-module grants** per user: none / view / edit. Checked on the server for every route and every SSE subscription; the client hiding a tile is never the protection.
- **Data scope** per module: personal (each user has their own) or shared. Calendar and todo support both, with per-calendar and per-list sharing.
- **App passwords** for CalDAV clients: one per device, revocable, limited to calendar access.
- The second person starts with: calendar (edit, shared calendars), todo (edit, shared lists), plus whatever read-only modules the admin grants [C].

### 5.8 App launcher (Skills App placeholder) [D]

- Entries live in `config/launcher.yaml` on the server: name, icon, working directory, start command, stop command, port, health-check URL, start timeout, "pause dashboard jobs while running" flag, allowed users.
- **That file is edited over SSH only.** The web UI can start, stop and open entries; it cannot create or change commands.
- Each entry runs as its own systemd unit under a separate unprivileged user, with memory and CPU limits.
- Flow: click → dashboard optionally enters minimal mode (pauses `whenViewed` jobs and non-critical `always` jobs) → unit starts → dashboard polls the health URL → "Open" button appears → app opens under its own path/port through Caddy with a small "back to dashboard" control. Stopping the app restores normal mode.
- The Skills App entry ships as a commented example to fill in later.

## 6. Security

Threat picture: a home network with controllable devices and private household data; the realistic risks are a stolen or compromised phone/laptop, a malicious feed or API response, a vulnerable dependency, and a mistake that exposes the service publicly.

**Network**
- The app listens on localhost only. Caddy is the single entrance and listens on the Tailscale interface with HTTPS. Plain-LAN HTTP access is off by default (it would also break PWA install and push) [C].
- Firewall (ufw): deny inbound by default; allow HTTPS on `tailscale0`; allow SSH from LAN and tailnet only, key-only, no root login.
- No router port forwarding. Tailscale ACLs limit the second person's devices to HTTPS on this machine.
- The second person joins through their own Tailscale account with the machine shared to them, or as a tailnet member under that ACL.

**Application**
- Server-side permission check on every route, SSE subscription and CalDAV request.
- Strict Content-Security-Policy; no inline scripts; no third-party scripts or fonts at runtime.
- All outbound requests go through the host `http` service: per-module host allowlist, timeouts, size caps.
- Request-forgery protection for user-supplied addresses: RSS and ICS URLs must resolve to public addresses; device addresses (WLED, NAS, sensors) must be in private ranges and are admin-only.
- Feed and API content is treated as untrusted: HTML sanitized before display, images fetched and re-encoded by the server, never hot-linked.
- Secrets (API keys, NAS password, app passwords) encrypted at rest with a key from a root-owned file; never returned to the browser.
- The NAS is accessed with a dedicated read-only account.
- Sensor ingest endpoints (later, ESP32) use per-device tokens and accept only declared fields.
- Audit log of sign-ins, permission changes, launcher actions.

**Host**
- Dedicated unprivileged service user; systemd sandboxing (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, restricted address families, memory limit).
- The LAN device scan needs raw-socket capability; it runs as a separate tiny helper unit with only that capability, not in the main process.
- Debian `unattended-upgrades` for security patches.
- Dependencies pinned by lockfile; `pnpm audit` in CI and in the install script; no post-install scripts from dependencies unless allowlisted.

**Data**
- Nightly SQLite backup (online backup API), kept locally for 7 days and copied to the NAS when configured; encrypted before leaving the machine. Restore procedure documented and tested.
- Automatic backup before every migration.

## 7. Performance

Budgets, checked in CI and on the real machine:

| Budget | Target |
|---|---|
| Server memory at rest | < 200 MB |
| Server CPU, nobody connected | < 2 % average |
| Shell JavaScript (compressed) | < 150 KB; modules and themes load on demand |
| Dashboard interactive on a mid-range phone | < 2 s on tailnet |
| Tile update after data change | < 1 s |

Means:
- `whenViewed` jobs; jitter; shared response cache; conditional requests.
- One SSE connection per client; only changed data is pushed.
- SQLite in WAL mode; writes batched; time-series downsampled (network stats: 10 s raw for 24 h, 1 min for 30 days, 1 h for a year) to bound size and SSD wear.
- Static assets precompressed and cached with content hashes; a service worker keeps the shell available offline and shows last known data.
- Background scenes degrade automatically (5.6); canvas charts; no heavy UI framework runtime.
- Images resized and cached on the server once.
- Launcher minimal mode frees CPU and memory for a launched app.

## 8. Modules

Each row is one independent work item after the core exists. "Source" lists the default; every external source sits behind a small adapter so it can be swapped.

### 8.1 Wave 1 — core of the day

| Module | Tile | Detail pane | Source / notes |
|---|---|---|---|
| **Clock** | Time, date; face from theme | World clocks, timer, alarm, stopwatch | Local. Faces come from themes. |
| **Calendar** | Today + next events | Month / week / day / agenda, create and edit, drag to move, repeat rules | Own data. See 8.5. |
| **Todo** | Due today, counts per list | Lists: Week, Month, Deadline, Shopping, Chores; icons, assignee, repeat, chore rotation | Own data. Items come from manual entry or calendar commands. |
| **Weather** | Now, next rain, pollen, air quality | Hourly graph, 7 days, pollen by type, air quality, sun, UV | Open-Meteo (forecast, air quality, pollen); no key. |
| **Today briefing** | Next event, due todos, weather hint, alerts | Full day agenda | Reads other modules' events only. |
| **Notification center** | Unread count, latest alert | History, filters, per-source mute | Bus. Optional Web Push to phones. |

### 8.2 Wave 2 — house and network

| Module | Tile | Detail pane | Source / notes |
|---|---|---|---|
| **WLED master** | Board/group toggles with custom icons | Per board and group: power, brightness, color, effect, presets; add boards (manual or discovery) | WLED JSON API on LAN, live state over WebSocket. |
| **Network monitor** | Up/down, latency, throughput sparkline | Graphs for latency, loss, throughput, DNS time; device list; outage history | Server-side probes; device scan helper; optional router adapter (e.g. Fritz!Box TR-064) and scheduled speed test. |
| **NAS (Synology)** | Volume usage, health badge | Per-disk SMART status, temperatures, volume and RAID state, usage history | Adapter: DSM Web API with read-only account, SNMP fallback. Model/DSM version to be supplied. |
| **Server health** | CPU temp, RAM, disk | History graphs, uptime, last backup | Local. |
| **Service pings** | Green/red list | Response-time history | Configurable targets. |
| **Quick links** | Icon grid | — | Config only. |

### 8.3 Wave 3 — information and leisure

| Module | Tile | Detail pane | Source / notes |
|---|---|---|---|
| **RSS** | Newest N items of a feed | Reader list, mark read, "read later" → todo | Any feed URL; one tile per feed or group. |
| **Moon & tides** | Phase, next high/low tide | Month of phases, rise/set, tide curve | Moon computed locally; tides from Open-Meteo Marine for a chosen coast point. |
| **Stocks** | Watchlist with change and sparkline | Chart per symbol, thresholds | Adapter; default needs a free API key (e.g. Finnhub). |
| **Quote / photo / art of the day** | The item | Full view, source, history | Quote: bundled list + API. Photo: Wikimedia picture of the day. Art: museum open-access APIs. |
| **GitHub repo of the day** | Name, stars, one line | README excerpt, history, "save" → todo | GitHub search API; optional token. |
| **Countdowns & birthdays** | Next few | All, add/edit | Own data + calendar `#birthday`. |
| **Shared notes** | Latest note | Pinboard | Own data. |
| **Habit tracker** | Today's checkboxes | Streaks, history | Own data. |
| **Focus timer** | Timer state | Sessions, stats | Local; publishes events for WLED. |

### 8.4 Later

Smart home status (ESP32 sensors over MQTT or HTTP ingest, air-quality graphs, thresholds), departures (local transit), waste collection (from an ICS subscription), meal plan (pushes ingredients to shopping list), fuel prices (Tankerkönig), energy price, user-editable automation rules.

### 8.5 Calendar in detail [D: own calendar + phone sync]

- **Data:** events stored in standard iCalendar form (the raw component plus indexed columns for queries), including repeat rules, exceptions, time zones, all-day events.
- **Calendars:** many per user. Each has an owner, a color, and shares (view / edit) to other users. Read-only subscriptions to public ICS links (holidays, school breaks, waste collection).
- **Web UI:** month, week, day, agenda; create, edit, drag, resize; per-person colors and filters.
- **Phone and desktop sync (CalDAV):** the server speaks the CalDAV subset that Apple Calendar, DAVx⁵ (Android) and Thunderbird need: discovery, listing, calendar queries, multi-get, create/update/delete with ETags, change tokens for incremental sync. Sign-in with per-device app passwords. Built inside the app [C], after the web calendar works, and verified against those three real clients.
- **Commands.** Typed in an event's title or description, from the web UI or any synced phone app. One parser; each command is a small plug-in. Processing is idempotent: derived items are linked to the event and updated or removed when the event changes or is deleted.

| Command | Effect |
|---|---|
| `@User` | Todo for that person, due at event time |
| `#shopping a, b, c` | Items onto the shopping list |
| `#chore` | Entry in chores, optional rotation between users |
| `!remind 30m` | Reminder alert before the event |
| `!countdown` | Countdown tile until the event |
| `!pin` | Pinned to the top of the dashboard that day |
| `!prep 2d` | Auto-todo "prepare …" two days before |
| `!wled <scene>` | WLED scene at event start |
| `#outdoor` | Attach weather and pollen forecast for that slot; warn if bad |
| `#private` | Hidden from other users even on a shared calendar |
| `#birthday` | Yearly repeat and age counter |

## 9. Deployment and operations

- **`deploy/install.sh`** is idempotent and is the only install/update entry point: checks prerequisites, installs Node and pnpm at pinned versions, installs dependencies from the lockfile, builds, backs up the database, runs migrations, installs/refreshes systemd units, Caddy config and firewall rules, restarts the service, runs a health check, prints the result.
- **Update [D]:** `ssh` → `git pull` → `./deploy/install.sh`.
- **Rollback:** check out the previous tag, restore the pre-migration backup, run the install script.
- **First-time setup guide** covers Debian minimal install, SSH hardening, Tailscale join and ACLs, HTTPS certificate, first admin account, adding the second person, adding their phone calendar.
- **Health endpoint** and a `doctor` command that reports service state, disk space, backup age, certificate expiry, failing jobs.
- Releases are git tags; a changelog is kept.

## 10. Testing

- **Unit tests** (Vitest) for core services and every module's logic.
- **Module contract tests:** one generic suite runs against every module: manifest valid, jobs survive network failure and bad data, routes enforce permissions, tile and detail render from fixtures in every theme (day and night) without errors.
- **Theme contract tests:** tokens complete, contrast checks for text, every module's default tile renders, overrides accept the module's fixture data.
- **No live network in tests.** External services are replayed from recorded fixtures.
- **End-to-end** (Playwright): sign-in, page editing, calendar create → todo via `@User`, permission denial for the second user, pane open/close on phone size.
- **CalDAV:** protocol tests plus a manual checklist against the three target clients.
- **On-device check:** performance budgets measured on the Futro before a release is tagged.

## 11. Build order and parallel work

Detailed in the implementation plan; the shape is:

1. **Foundations (serial, one agent).** Repo, tooling, CI, and the frozen contracts: module contract, theme contract, event catalog, mock host. Everything parallel depends on this being stable.
2. **Core (about five parallel tracks).** Server core and services · auth and permissions · web shell (pages, grid, pane, settings) · theme engine + Default theme · deployment and hardening.
3. **Reference slice (serial).** Clock module + Default theme end to end, on the real machine. Proves the contracts; fixes go back into them before fan-out.
4. **Modules (wide parallel, one agent per module, in the waves of section 8).** Each agent works only inside its module folder against the mock host.
5. **Themes (three parallel agents).** Space, Gloomy, Medieval, including backgrounds and selected tile overrides.
6. **Cross-cutting (parallel).** Built-in links · CalDAV · app launcher · Web Push · backups.
7. **Hardening and release.** Security review, performance pass on the device, setup guide, first tagged release.

## 12. Open items (not blocking the plan)

Each is a configuration value or an adapter choice, not a design change:

- Synology model and DSM version (decides API vs SNMP adapter details).
- Location for weather, sun, moon; coast point for tides.
- Router brand (decides whether a router adapter is worth building).
- Skills App: folder, start command, port, health URL.
- Futro RAM and SSD size (confirms budgets).
- Stock data provider preference.

## 13. Left to the builder

Library choices not named here, internal file structure inside `apps/` and each module, exact database schema, visual detail of each theme beyond the direction shown in the mockups, wording of UI text, and the test fixtures.
