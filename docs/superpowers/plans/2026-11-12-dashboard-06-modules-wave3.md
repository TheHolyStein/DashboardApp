# Dashboard 06 — Modules Wave 3 (Information and Leisure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build nine small modules: RSS, Moon & tides, Stocks, Daily item (quote/photo/art), GitHub repo of the day, Countdowns & birthdays, Shared notes, Habit tracker, Focus timer.

**Architecture:** One agent per module in `modules/<id>/`. Each is one task unless noted; all follow the playbook.

**Tech Stack:** as master plan; RSS adds `fast-xml-parser` and `sanitize-html`; Moon adds `suncalc`; Daily item adds `sharp` (image re-encoding).

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (section 8.3)

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply. Every agent follows **Part 1 of plan 03 (Module playbook)** and the **Standard task cycle**.

## Review Focus

None owned beyond the generic suites. RSS and Daily item handle hostile remote content: their sanitising tests below are mandatory.

**Shared rule for remote images (rss, daily, github):** never give the browser a remote URL. Fetch with `host.http` (`as:'buffer'`, `maxBytes: 8_000_000`), verify the magic bytes are JPEG/PNG/WebP/GIF (SVG refused), re-encode with `sharp` to WebP max 1600 px wide (thumbnail 480 px), store with `host.store.blob.put('img:<sha256>', …, 'image/webp')`, serve from a module route `GET /img/:hash` (view) returning `new BinaryResponse(data, 'image/webp', 'private, max-age=604800')`. Blobs not referenced for 60 days are deleted by the module's own job.

---

## Module: `rss` (branch `module/rss`)

**Manifest:** scope `user`; `multiInstance: true`; tile default 4×3, min 2×2, max 8×8; `staleAfterSec: 7200`; levels `['view','edit']`; jobs `fetch` (1800 s, whenViewed, instance); publishes `item.readLater`; outbound `[{kind:'publicUrl'}]`.
Instance settings: `feeds: Array<{ url: string; title: string }>` (1–10, URL `http(s)` only), `count: number` (1–30, default 8), `showImages: boolean` (default false), `showSummary: boolean` (default true).

### Task RS1: Parse, sanitise, fetch

**Files:** `manifest.ts`, `server/{parse.ts,sanitize.ts,index.ts}`; fixtures `rss2.xml`, `atom.xml`, `rdf.xml`, `hostile.xml` (script tags, `onerror`, `javascript:` links, XML entity expansion bomb, 10 000 items), `latin1.xml`; Test `tests/parse.test.ts`, `tests/sanitize.test.ts`, `tests/server.test.ts`

```ts
export interface FeedItem { id: string; feedTitle: string; title: string; link: string | null; summary: string; publishedAt: string | null; imageHash: string | null }
export function parseFeed(xml: string, feedUrl: string): { title: string; items: FeedItem[] };   // RSS 2.0, Atom 1.0, RSS 1.0
export function cleanText(html: string, maxLen: number): string;                                 // tags stripped, entities decoded, whitespace collapsed
export type Snapshot = { items: Array<Pick<FeedItem, 'id'|'feedTitle'|'title'|'publishedAt'|'imageHash'> & { summary: string; read: boolean }> };
```
Rules: XML parser configured with entity expansion disabled and no external entities; at most 200 items per feed considered; `summary` is plain text ≤ 300 chars (no HTML reaches the client at all); `link` kept only if `http(s)`, resolved against the feed URL; item id = SHA-256 of `guid || link || title`; items merged across the instance's feeds, sorted by date desc; read state per user in `m_rss_read(user_id, item_id, at)` (pruned after 60 days); fetch with `ttlSec: 900`, `maxBytes: 3_000_000`; a failing feed keeps its previous items and shows a per-feed error flag in the detail route.
Routes: `GET /items?instanceId` (view, up to 100); `POST /read` (view — own state; in `viewWrites`) `{ids}`; `POST /later` (edit) `{id}` → publishes `item.readLater`; `POST /test` (edit) `{url}` → `{ok, title, count}` for the settings form.

**Tests:** `parses each of the three formats to exact items`; `hostile.xml: no "<", no "javascript:", no "onerror" anywhere in output; entity bomb does not expand; only 200 items kept`; `latin1 feed decodes umlauts`; `relative link resolved`; `ftp: link dropped`; `one failing feed of two keeps the other's items`; `read state is per user`; contract suites.

- [ ] Standard task cycle

### Task RS2: Tile and detail

**Files:** `client/{Tile,Detail,Settings}.svelte`; Test `tests/client.test.ts`

Tile: newest `count` headlines, feed name, relative time, unread dot; optional thumbnail. Detail: reader list with summaries, "open original" (new tab, `rel="noopener noreferrer"`), mark read, "read later" (`data-edit`). Settings: feed rows with a "test" button.

**Tests:** contract suites; `headline click marks read`; `test button shows feed title or error`.

- [ ] Standard task cycle

---

## Module: `moon` (branch `module/moon`)

**Manifest:** scope `shared`; `multiInstance: true`; tile default 2×2, min 1×1, max 6×4; levels `['view']`; jobs `moon` (600 s, always, module), `tides` (10800 s, whenViewed, instance); publishes `moon.updated`; outbound host `marine-api.open-meteo.com`.
Module config: `home: {lat, lon}`. Instance settings: `showTides: boolean` (default false), `tidePoint: { name: string; lat: number; lon: number } | null`.

### Task MO1: Whole module

**Files:** `manifest.ts`, `server/{moon.ts,tides.ts,index.ts}`, `client/{Tile,Detail,MoonDisc}.svelte`; fixtures `marine.json`; Test `tests/moon.test.ts`, `tests/tides.test.ts`, `tests/client.test.ts`

```ts
export function moonInfo(at: Date, lat: number, lon: number): { phase: number; illumination: number; name: PhaseName; rise: string | null; set: string | null; nextFull: string; nextNew: string };
export type PhaseName = 'new'|'waxing-crescent'|'first-quarter'|'waxing-gibbous'|'full'|'waning-gibbous'|'last-quarter'|'waning-crescent';
export function extremes(series: Array<[t: string, heightM: number]>): Array<{ at: string; kind: 'high'|'low'; heightM: number }>;   // local maxima/minima, parabolic interpolation between hourly points
export type Snapshot = { phase: number; illumination: number; name: PhaseName; rise: string | null; set: string | null; nextFull: string;
  tide: { place: string; next: Array<{ at: string; kind: 'high'|'low'; heightM: number }> } | null };
```
Rules: moon computed locally with `suncalc`; phase names by eighths with ±0.03 windows around the four principal phases; `moon.updated` published when the phase changes by ≥ 0.01 and at startup; tides from Open-Meteo Marine hourly `sea_level_height_msl` for 7 days (`ttlSec: 10000`); README states tide times are model estimates, not for navigation. `MoonDisc` draws the lit fraction as SVG from `phase` (correct orientation for the northern/southern hemisphere by latitude sign). Detail: month grid of phases, rise/set today, 7-day tide curve with marked extremes.

**Tests:** `a known full-moon date has illumination > 0.98` and `a known new-moon date has illumination < 0.02` (take three dates of each from a published almanac and cite the source in the test file); `name windows at boundaries`; `extremes finds alternating highs and lows on a synthetic sine with 12.42 h period within 10 min`; `no tide point → tide null and no request`; `MoonDisc path flips for southern latitude`; contract suites.

- [ ] Standard task cycle

---

## Module: `stocks` (branch `module/stocks`)

**Manifest:** scope `user`; `multiInstance: true`; tile default 3×2, min 2×1, max 6×6; `staleAfterSec: 3600`; levels `['view','edit']`; jobs `quotes` (300 s, whenViewed, module), `watch` (900 s, always, module); publishes `stock.threshold`; outbound host `finnhub.io`.
Module config: `provider: 'finnhub'`; secret `apiKey`. Instance settings: `symbols: string[]` (1–15, `^[A-Z0-9.\-:]{1,15}$`), `showSparkline: boolean`.

### Task ST1: Whole module

**Files:** `manifest.ts`, `server/{provider.ts,finnhub.ts,thresholds.ts,index.ts}`, `client/{Tile,Detail}.svelte`; fixtures `quote.json`, `candles.json`, `search.json`; Test `tests/finnhub.test.ts`, `tests/thresholds.test.ts`, `tests/client.test.ts`

```ts
export interface QuoteProvider { quote(host, symbol): Promise<{ price: number; prevClose: number; at: string; currency: string | null }>;
  history(host, symbol, range: '1d'|'1m'|'1y'): Promise<Array<[number, number]>>; search(host, q: string): Promise<Array<{ symbol: string; name: string }>> }
export type Snapshot = { needsSetup?: true; quotes: Array<{ symbol: string; price: number; changePct: number; spark: Array<[number, number]> }> };
```
Rules: the union of all instances' symbols is fetched once per run by the module job (`ttlSec: 240` per symbol), at most 30 requests per minute (queue with spacing) to respect the free tier; each instance's snapshot is cut from the shared result; thresholds in `m_stocks_thresholds(user_id, symbol, direction, price, armed)`: when crossed publish `stock.threshold` + notify that user once, then disarm until the price returns across the line; the `watch` job covers symbols with armed thresholds even when nobody is viewing. API key only in `host.secrets`, sent as header `X-Finnhub-Token`, never as a query parameter. Routes: `GET /history?symbol&range` (view); `GET /search?q` (view); `GET/PUT/DELETE /thresholds` (edit).

**Tests:** `maps quote fixture; changePct = (price − prevClose)/prevClose`; `no api key → needsSetup, no request`; `rate limiter spaces 40 symbols over > 60 s`; `threshold fires once and re-arms after crossing back`; `api key not in any request URL`; `invalid symbol rejected by schema`; contract suites.

- [ ] Standard task cycle

---

## Module: `daily` (branch `module/daily`)

**Manifest:** scope `shared`; `multiInstance: true`; tile default 4×3, min 2×2, max 12×8; levels `['view']`; jobs `pick` (3600 s, always, instance); outbound hosts `zenquotes.io`, `commons.wikimedia.org`, `upload.wikimedia.org`, `api.wikimedia.org`, `api.artic.edu`, `www.artic.edu`.
Instance settings: `kind: 'quote'|'photo'|'art'` (default `quote`), `fit: 'cover'|'contain'`, `showCaption: boolean`.

### Task DA1: Whole module

**Files:** `manifest.ts`, `server/{sources/quote.ts,sources/photo.ts,sources/art.ts,images.ts,index.ts}`, `server/quotes.json` (300 bundled public-domain quotes as offline fallback), `client/{Tile,Detail}.svelte`; fixtures per source; Test `tests/sources.test.ts`, `tests/images.test.ts`, `tests/client.test.ts`

```ts
export type Snapshot = { kind: 'quote'; text: string; author: string; date: string }
                     | { kind: 'photo'|'art'; title: string; credit: string; sourceUrl: string; imageHash: string; thumbHash: string; date: string };
export interface DailySource { pick(host: HostServices, date: string): Promise<Snapshot> }
```
Rules: one item per local date per instance kind; the job is a no-op once today's item exists; quote: ZenQuotes `/api/today`, on failure pick from `quotes.json` by day-of-year index; photo: Wikimedia Commons picture of the day via the featured-content feed for the date; art: Art Institute of Chicago API — search public-domain artworks with an image, choose by deterministic index from the date, image via its IIIF URL at 1686 px; images go through the shared image rule; `credit` is plain text (sanitised); history of the last 30 items per kind in `m_daily_items`. Routes: `GET /img/:hash` (view); `GET /history?kind` (view). Tile: quote typeset large, or image with caption overlay; detail: full image, credit, link to source, history strip.

**Tests:** `quote source maps fixture`; `quote upstream failure falls back to bundled quote deterministically`; `photo/art sources map fixtures to title, credit, image URL`; `SVG and HTML disguised as image are refused`; `image re-encoded to webp ≤ 1600 px`; `second run on same date makes no request`; `credit with HTML is stripped`; contract suites.

- [ ] Standard task cycle

---

## Module: `github` (branch `module/github`)

**Manifest:** scope `shared`; `multiInstance: true`; tile default 4×2, min 2×2, max 8×6; levels `['view','edit']`; jobs `pick` (3600 s, always, instance); publishes `item.readLater`; outbound host `api.github.com`.
Module config: secret `token` (optional, raises rate limit). Instance settings: `languages: string[]` (default any), `topics: string[]`, `minStars: number` (default 50), `window: 'week'|'month'|'year'` (repos created within; default `month`).

### Task GH1: Whole module

**Files:** `manifest.ts`, `server/{search.ts,index.ts}`, `client/{Tile,Detail}.svelte`; fixtures `search.json`, `readme.json`; Test `tests/search.test.ts`, `tests/client.test.ts`

```ts
export function buildQuery(s: Settings, today: string): string;       // e.g. "created:>2026-10-12 stars:>=50 language:rust topic:cli"
export type Snapshot = { fullName: string; description: string; stars: number; language: string | null; topics: string[]; url: string; date: string };
```
Rules: one repo per local date per instance; `GET /search/repositories?q=…&sort=stars&order=desc&per_page=30`; choose the highest-starred repo not shown in the last 60 days (`m_github_seen`); description is plain text ≤ 300 chars; README excerpt for the detail pane: fetch README as raw text, convert to plain text, first 1500 chars (no HTML/Markdown rendering); `Authorization: Bearer` only when a token is set; 403/429 rate limit → keep yesterday's repo and mark stale. Routes: `GET /readme` (view); `GET /history` (view); `POST /later` (edit) → `item.readLater`.

**Tests:** `buildQuery for settings combinations`; `skips repos seen in the last 60 days`; `rate-limited response keeps previous snapshot`; `README markdown reduced to plain text without tags`; contract suites.

- [ ] Standard task cycle

---

## Module: `countdowns` (branch `module/countdowns`)

**Manifest:** scope `shared`; `multiInstance: true`; tile default 3×2, min 2×1, max 6×6; levels `['view','edit']`; jobs `refresh` (3600 s, always, module); subscribes `countdown.request`; outbound `[]`.
Instance settings: `max: number` (1–10, default 4), `show: 'all'|'birthdays'|'countdowns'`.

### Task CD1: Whole module

**Files:** `manifest.ts`, `server/{items.ts,index.ts}`, `client/{Tile,Detail}.svelte`; Test `tests/items.test.ts`, `tests/client.test.ts`

Table `m_countdowns_items(id, owner_id, visibility, kind 'countdown'|'birthday', title, icon, date, year_of_birth, yearly, source_key UNIQUE NULL)`.
```ts
export function nextOccurrence(item, today: string): string;                 // yearly items roll to next year; Feb 29 → Feb 28 in non-leap years
export function daysUntil(dateIso: string, today: string): number;
export type Snapshot = { items: Array<{ id: string; title: string; icon: string; date: string; days: number; kind: string; turns: number | null }> };
```
Rules: `countdown.request` upserts by `sourceKey`; passed non-yearly countdowns are removed the day after; a birthday notifies its owner (or everyone, if shared) at 08:00 local on the day and 7 days before (deduped); CRUD routes `GET/POST/PATCH/DELETE /items` with the usual private/shared visibility.

**Tests:** `yearly rolls over`; `Feb 29 birthday in 2027 is Feb 28`; `turns = year − year_of_birth`; `request with same sourceKey updates`; `passed countdown removed next day`; contract suites.

- [ ] Standard task cycle

---

## Module: `notes` (branch `module/notes`)

**Manifest:** scope `shared`; `multiInstance: true`; tile default 3×3, min 2×2, max 8×8; levels `['view','edit']`; no jobs; outbound `[]`.
Instance settings: `boardId: string` (default `shared`), `max: number` (default 3).

### Task NO1: Whole module

**Files:** `manifest.ts`, `server/index.ts`, `client/{Tile,Detail,NoteCard}.svelte`; Test `tests/server.test.ts`, `tests/client.test.ts`

Table `m_notes_notes(id, board_id, author_id, text, color, pinned, version, created_at, updated_at)`. Rules: text is plain text ≤ 2000 chars, rendered with line breaks and auto-linked `http(s)` URLs only (built as DOM nodes, never `{@html}`); `@handle` in a new note notifies that user; version-checked updates (409 on mismatch); boards: `shared` plus one private board per user (`user:<id>`); snapshot = pinned first then newest, ≤ `max`.

**Tests:** `note with <script> renders as text`; `stale version → 409`; `@mention notifies once`; `private board invisible to others`; contract suites.

- [ ] Standard task cycle

---

## Module: `habits` (branch `module/habits`)

**Manifest:** scope `user`; `multiInstance: false`; tile default 3×2, min 2×1, max 6×6; levels `['view','edit']`; jobs `midnight` (600 s, always, module); outbound `[]`.

### Task HB1: Whole module

**Files:** `manifest.ts`, `server/{streaks.ts,index.ts}`, `client/{Tile,Detail,Heatmap}.svelte`; Test `tests/streaks.test.ts`, `tests/client.test.ts`

Tables `m_habits_habits(id, owner_id, title, icon, days_mask, archived)`, `m_habits_checks(habit_id, date, PRIMARY KEY(habit_id, date))`.
```ts
export function streak(checks: Set<string>, daysMask: number, today: string): { current: number; best: number };   // non-scheduled weekdays neither break nor extend
export type Snapshot = { date: string; habits: Array<{ id: string; title: string; icon: string; doneToday: boolean; scheduledToday: boolean; current: number }> };
```
Rules: dates are the user's local dates; `midnight` re-pushes snapshots when a user's local date changes; routes `GET/POST/PATCH /habits`, `PUT /habits/:id/check` `{date, done}` (edit; only today and the previous 6 days). Detail: 12-week heatmap per habit, best/current streak.

**Tests:** `streak counts consecutive scheduled days`; `unscheduled weekday does not break streak`; `today not yet done keeps yesterday's streak`; `check older than 6 days → 422`; contract suites.

- [ ] Standard task cycle

---

## Module: `focus` (branch `module/focus`)

**Manifest:** scope `user`; `multiInstance: false`; tile default 2×2, min 2×1, max 4×4; levels `['view','edit']`; jobs `tick` (5 s, always, module); publishes `focus.phase`, `timer.finished`; outbound `[]`.
Instance settings: `workMin` (default 25), `breakMin` (5), `longBreakMin` (15), `longEvery` (4), `autoStartNext: boolean` (false).

### Task FO1: Whole module

**Files:** `manifest.ts`, `server/{machine.ts,index.ts}`, `client/{Tile,Detail,Ring}.svelte`; Test `tests/machine.test.ts`, `tests/client.test.ts`

```ts
export type Phase = 'idle'|'work'|'break';
export interface State { phase: Phase; endsAt: string | null; pausedRemainingSec: number | null; completedToday: number; round: number }
export function step(state: State, action: { type: 'start'|'pause'|'resume'|'skip'|'reset'|'tick' }, now: Date, s: Settings): { state: State; events: Array<'work-ended'|'break-ended'> };
```
Rules: state is server-side per user (survives closing the browser, same on phone and PC); the client counts down locally from `endsAt`; on phase end: publish `focus.phase` with the new phase, `timer.finished` with label `Focus` / `Break`, notify the user (info); every 4th break is long; sessions logged in `m_focus_sessions(user_id, started_at, minutes)`; `completedToday` resets at local midnight. Routes: `POST /action` (edit) `{type}`; `GET /stats?days` (view). Detail: today's rounds, 14-day bar chart of focus minutes.

**Tests:** `start → work with endsAt now+25 min`; `tick past endsAt → break and events work-ended`; `4th break is long`; `pause/resume preserves remaining seconds`; `autoStartNext false returns to idle after break`; `two devices see the same state`; contract suites.

- [ ] Standard task cycle
