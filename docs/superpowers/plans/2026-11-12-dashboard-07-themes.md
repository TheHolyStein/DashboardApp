# Dashboard 07 — Themes (Space, Gloomy, Medieval)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three complete aesthetics, each with day and night, a voice, icons, clock faces, four reactive background scenes, a pane transition, chart palette, and selected full tile overrides.

**Architecture:** One agent per theme in `themes/<id>/` only. A theme is data + CSS + Svelte components behind the `ThemeManifest` contract; it never imports a module. Tile overrides consume the module's exported `Snapshot` type by copying the type locally (a theme may not import module code) and are tested against the module's `fixtures/tile.json`.

**Tech Stack:** Svelte 5, CSS custom properties, Canvas 2D for animated scenes (no WebGL, no animation libraries), self-hosted WOFF2 fonts under OFL/Apache licences.

**Spec:** `docs/superpowers/specs/2026-11-12-home-dashboard-design.md` (section 5.6). Visual direction: `.superpowers/brainstorm/*/content/themes.html` (mockups approved by the owner).

## Global Constraints

See `2026-11-12-dashboard-00-master.md` → Global Constraints. All apply, plus:

- **Fonts** live in the theme folder as WOFF2, licence file beside them; total font payload per theme ≤ 300 KB; `font-display: swap`.
- **Scene budget:** `full` ≤ 4 ms average frame cost on a mid-range phone, capped at 30 fps; `calm` ≤ 1 frame per second or CSS-only; `static` = one WebP ≤ 150 KB per scene per mode. Scenes stop drawing when the tab is hidden.
- **Theme chunk** (CSS + manifest + icons, without scenes and fonts) ≤ 40 KB gzip. Scenes, clock faces and tile overrides are lazy.
- **Contrast** per `CONTRAST_PAIRS`; text over a scene always sits on a tile surface, never directly on the scene.
- **Art assets** are original (drawn in code or created for this project). No copied artwork, no stock imagery of unclear licence.

## Review Focus

None owned beyond `runThemeContractSuite`. Extra care: reduced-motion users and weak phones must get a calm, fully usable dashboard in every theme.

---

## Part 1 — Theme playbook (every theme agent follows this)

**Folder (created by `pnpm new:theme <id>`):**
```
themes/<id>/
  package.json          @dash/theme-<id>
  theme.ts              defineTheme({...})
  tokens.css            every REQUIRED_TOKENS for [data-mode=day] and [data-mode=night]
  base.css              theme-wide rules: tile chrome, headings, scrollbars, focus ring, pane keyframes
  fonts/                *.woff2 + LICENSE
  icons.ts              svg strings for ICON_KEYS (missing → default theme)
  strings.ts            voice overrides per locale
  clock/<Face>.svelte
  background/<Scene>.svelte + <scene>-day.webp, <scene>-night.webp
  tiles/<module-id>.svelte        optional overrides
  tests/theme.test.ts   runThemeContractSuite + scene/override tests
  README.md             direction, fonts and licences, list of overrides
```

**Order of work:**
1. Tokens for both modes; run the suite's token and contrast cases until green.
2. `base.css`: tile chrome (border, clip, surface, header style), pane open/close keyframes named in `pane`.
3. Icons, strings.
4. Clock faces (at least two).
5. Scenes: start with `static` images, then `calm`, then `full`.
6. Chart palette.
7. Tile overrides listed in your brief.
8. Manual pass with `pnpm dev`: every installed module, day and night, phone width, reduced motion on, each scene, each intensity.
9. README and final report.

**Scene component rules:** props are `BackgroundProps`. Draw on a single `<canvas>` sized to the viewport at `devicePixelRatio` capped at 1.5. All randomness is seeded from the scene id so it does not jump on re-render. React to `env` smoothly (interpolate over ≥ 2 s). `env` fields may be `null`: fall back to the mode's default look. Export nothing but the component.

**Tile override rules:** an override receives the same `TileProps` as the default tile and must: render `data === undefined` and `stale` states; work at the module's min and max size; keep every control the default tile has (with `data-edit`) and call `openDetail` on body click; use `t()` for text. An override that cannot fit the module's min size falls back by rendering the default — signalled by `export const minSize = {w,h}` in the override; the shell checks it.

**Voice rules:** `strings.ts` overrides keys only; the same keys the modules use (`module.<id>.name`, `m.<id>.<key>`, shell keys `shell.*`). Never change meaning — "Calendar" may become "Chronicle", a button "Delete" stays understandable ("Strike out" is fine, "Banish" needs the icon to carry it).

**Standard tests every theme adds beyond the suite:** each scene renders with all-null `env` and with a full `env` for both modes at all three intensities; `static` renders an `<img>` and no canvas; each override passes the client contract cases 1–4 and 7 using the module's fixture.

---

## Theme: `space` (branch `theme/space`)

**Direction:** ship console in deep space. Cut-corner tiles, thin cyan outlines with soft glow at night; clean ice-white "station daylight" by day. Headings uppercase, wide tracking.

**Tokens (starting values; tune for contrast):** night — bg `#070a1a`, fg `#e6f4ff`, muted `#7f93c2`, accent `#4de3ff`, accent-2 `#b388ff`, surface `rgba(20,30,70,.55)`, border colour `rgba(77,227,255,.45)`; day — bg `#e8f0fa`, fg `#0d1b33`, muted `#5a6c8c`, accent `#0077b6`, accent-2 `#6a4fd8`, surface `rgba(255,255,255,.82)`. `--db-tile-clip: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))`; radius `2px`; heading case `uppercase`, track `.14em`. Fonts: Orbitron (headings, display), Share Tech Mono (body, mono).

**Voice:** Calendar → "Mission log", Todo → "Directives", Weather → "Atmos", Clock → "Chrono", Network → "Comms", NAS → "Cargo bay", Notifications → "Alerts", Briefing → "Daily brief", Settings → "Systems"; page default names unchanged.

### Task SP1: Tokens, chrome, icons, voice, chart, pane
Chrome: corner brackets drawn with `::before/::after`, scan-line shimmer on tile hover (disabled under reduced motion). Pane: "console slide" — scale-Y from 0.92 with a 1-frame bright edge, 220 ms. Chart: neon lines, `glow: true` at night, `fill: .12`. Icons: thin-stroke geometric set for all `ICON_KEYS`.
**Tests:** suite cases manifest/tokens/contrast/css/fonts.
- [ ] Standard task cycle

### Task SP2: Clock faces
`Segment` (seven-segment digits drawn in SVG, seconds as a thin progress arc), `Orbit` (analogue: hands are orbiting bodies on rings), `Stardate` (digital time plus day-of-year "SOL nnn" line).
**Tests:** suite clock cases; `Orbit hour body angle is 90° at 03:00`; `Segment renders 12-hour with hour12`.
- [ ] Standard task cycle

### Task SP3: Scenes
| Scene | Look | Reacts |
|---|---|---|
| `starfield` | three parallax star layers drifting slowly | night: denser, shooting star every 20–60 s; `storm` weather: brief aurora bands |
| `nebula` | soft multi-octave value-noise clouds rendered once to an offscreen canvas, slow hue drift | weather tints hue (clear → teal, rain → indigo, storm → magenta); day: pale and bright |
| `planet` | large limb of a planet with atmosphere glow and a small moon | the moon shows the real phase from `env.moonPhase`; planet terminator follows `env.sunAltitudeDeg` |
| `station` | window frame with slow-rotating starfield behind, panel light strips | strip colour follows mode; `fog`/`cloudy`: frost on the glass edges |
**Tests:** standard scene tests; `planet moon lit fraction equals env.moonPhase mapping at 0, .25, .5`.
- [ ] Standard task cycle

### Task SP4: Tile overrides
`clock` (the face fills the tile with a HUD ring showing day progress), `weather` ("atmospheric readout": concentric gauge of temperature within today's min/max, precipitation ticks around the ring for the next 12 h), `network` (radar sweep with latency as blip distance; sweep is CSS-only and stops under reduced motion), `moon` (the planet-scene moon rendering reused small).
**Tests:** override contract cases with each module's fixture; `weather gauge needle at 50 % when temp is midway between min and max`.
- [ ] Standard task cycle

---

## Theme: `gloomy` (branch `theme/gloomy`)

**Direction:** quiet, overcast, slightly gothic. Charcoal and fog, thin high-contrast serif, heavy soft shadows, one desaturated blood-red accent. No glow, almost no motion. Day mode is an overcast noon, not a bright theme.

**Tokens (starting values):** night — bg `#131416`, fg `#c9c7c1`, muted `#8a8990`, accent `#b0605a`, accent-2 `#6f8a8a`, surface `rgba(40,41,46,.88)`, border colour `#33343a`; day — bg `#c3c6ca`, fg `#2a2b2f`, muted `#5f6065`, accent `#7a3b38`, accent-2 `#4d6666`, surface `rgba(232,232,230,.8)`. Radius `4px`; shadow `0 10px 30px rgba(0,0,0,.6)` night / `.18` day; heading case `uppercase`, track `.2em`; clip `none`. Fonts: Cormorant Garamond (headings, display, body), IBM Plex Mono (mono).

**Voice:** Calendar → "Appointments", Todo → "Obligations", Weather → "Sky", Clock → "Hour", Network → "Lines", NAS → "Vault", Notifications → "Omens", Briefing → "This day".

### Task GL1: Tokens, chrome, icons, voice, chart, pane
Chrome: hairline border, inner vignette on tiles, heading underlined by a short rule. Pane: slow fade with slight downward settle, 320 ms. Chart: muted lines, `glow: false`, `fill: .2`, thin `lineWidth: 1.25`. Icons: fine engraved-line set.
**Tests:** suite cases.
- [ ] Standard task cycle

### Task GL2: Clock faces
`Mourning` (large thin serif digits with a blinking colon that does not blink under reduced motion), `Pendulum` (analogue face, roman-free bare ticks, swinging pendulum below; static pendulum in `calm`), `Almanac` (time small; weekday, date and moon phase name large).
**Tests:** suite clock cases; `Pendulum renders without animation class under reduced motion`.
- [ ] Standard task cycle

### Task GL3: Scenes
| Scene | Look | Reacts |
|---|---|---|
| `moor` | layered fog bands drifting over a low horizon | fog density from weather (`fog` max, `clear` min); night: faint moon glow sized by `env.moonPhase` |
| `forest` | bare tree silhouettes in three depth layers, slight sway | `storm`/`rain`: stronger sway and rain streaks; `snow`: slow flakes |
| `window` | rain-streaked pane, blurred lights beyond | drops only when weather is `drizzle`/`rain`/`storm`; otherwise condensation; night: warmer lights |
| `city` | overcast skyline silhouette with a few lit windows | windows light up as `env.sunAltitudeDeg` drops below 0; `fog`: skyline fades |
**Tests:** standard scene tests; `window scene draws zero drops when weather is clear`.
- [ ] Standard task cycle

### Task GL4: Tile overrides
`clock` (face over a faint weekday watermark), `weather` ("barometer": engraved dial with a needle from storm to fair, driven by condition and next precipitation), `quote` kind of `daily` (epitaph-style typesetting with ornament rule), `countdowns` (tally marks for days ≤ 30, numeral otherwise).
**Tests:** override contract cases; `barometer needle points to "storm" segment for condition storm`.
- [ ] Standard task cycle

---

## Theme: `medieval` (branch `theme/medieval`)

**Direction:** illuminated manuscript by day, candle-lit hall by night. Parchment surfaces, double-ruled borders, blackletter headings with a readable old-style body face, burgundy and gold.

**Tokens (starting values):** day — bg `#e2cc9a`, fg `#3b2412`, muted `#6e5132`, accent `#7b1e1e`, accent-2 `#2f4f3a`, surface `rgba(247,236,205,.78)`, border `3px double #7a5a38`; night — bg `#1d120a`, fg `#ecd9a8`, muted `#a08657`, accent `#d9a441`, accent-2 `#9c3b2e`, surface `rgba(48,30,16,.84)`, border `3px double #8a6a34`. Radius `3px`; heading case `none`, track `.02em`; clip `none`. Fonts: UnifrakturCook (headings only, ≥ 17 px), IM Fell English (body, display), IM Fell English SC (labels), a plain mono for data tables.

**Voice:** Calendar → "Chronicle", Todo → "Quests" (lists: "This sennight", "This moon", "By decree", "Market list", "Duties"), Weather → "Heavens", Clock → "Horologe", Network → "Messengers", NAS → "Treasury", Notifications → "Heralds", Briefing → "Hear ye", Settings → "Ordinances"; pages keep user names.

### Task MD1: Tokens, chrome, icons, voice, chart, pane
Chrome: double rule border with small corner ornaments (inline SVG background), drop-cap style first letter on tile headings ≥ 3 columns wide. Pane: "scroll unroll" — clip-path reveal from the centre line outwards with rod shapes at top and bottom, 300 ms (plain fade under reduced motion). Chart: ink lines `lineWidth: 1.5`, `fill: .15`, hatched grid. Icons: woodcut-style set. Numbers in data stay arabic for legibility; roman numerals only in clock faces and decorative dates.
**Tests:** suite cases; `blackletter font not applied below 17 px` (computed style check on small labels).
- [ ] Standard task cycle

### Task MD2: Clock faces
`Roman` (hours and minutes as roman numerals, e.g. `IX · XII`), `Sundial` (dial with a shadow at the hour angle by day; at night a candle whose height shows the remaining night), `Tower` (analogue tower-clock face with roman hour ring and a single ornate hand pair).
```ts
export function toRoman(n: number): string;   // 0 → "N", 1…59
```
**Tests:** `toRoman(0)="N", 4="IV", 9="IX", 14="XIV", 40="XL", 47="XLVII", 59="LIX"`; suite clock cases.
- [ ] Standard task cycle

### Task MD3: Scenes
| Scene | Look | Reacts |
|---|---|---|
| `map` | parchment with a hand-drawn imaginary coastline, compass rose, sea serpents | ink clouds drift when `cloudy`/`rain`; night: parchment darkens, candle-glow vignette |
| `hall` | stone wall with two torches and a banner | torch flicker in `full` (static flame in `calm`); banner sways in `storm`; day: light shaft from a slit window angled by `env.sunAltitudeDeg` |
| `glass` | stained-glass window casting coloured light patches | brightness follows sun altitude; rain streaks outside when raining; moon disc with real phase at night |
| `desk` | scriptorium desk: quill, inkwell, open book edge | candle lit at night; pages flutter once on page change (never under reduced motion) |
**Tests:** standard scene tests; `hall torch draws static flame in calm`.
- [ ] Standard task cycle

### Task MD4: Tile overrides
`clock` (face in an ornate frame), `weather` (heraldic shield: charge = condition emblem, chief shows temperature, base shows next rain as text), `todo` (quest scroll: items as a list with wax-seal checkboxes — keeps quick-add and all controls), `calendar` (illuminated agenda: date as a drop-cap numeral, events as lines beside it), `moon` (woodcut moon disc).
**Tests:** override contract cases with fixtures; `todo override keeps quick-add and checkboxes with data-edit`; `shield emblem changes with condition`.
- [ ] Standard task cycle

---

### Gate (per theme)

- [ ] `runThemeContractSuite` green; theme chunk and font budgets met (`pnpm check` budget step).
- [ ] Human looks at the manual pass screenshots (day/night × desktop/phone × two scenes), captured by `pnpm e2e --grep theme:<id>` into `docs/themes/<id>/`.
