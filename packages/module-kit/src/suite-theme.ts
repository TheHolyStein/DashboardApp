// Theme entry (`@dash/module-kit/theme`). Used by theme TEST files only; theme runtime code never imports the kit.
// Needs the jsdom environment (`// @vitest-environment jsdom` in the test file) and the Svelte compiler
// (`moduleVitestConfig` from `@dash/module-kit/vitest` in the theme's vitest.config.ts).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { flushSync } from 'svelte';
import { test } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import {
  CONTRAST_PAIRS,
  REQUIRED_TOKENS,
  validateTheme,
  type BackgroundProps,
  type ClockFaceProps,
  type Intensity,
  type Mode,
  type SceneEnv,
  type ThemeManifest,
  type TileProps,
  type Translate,
} from '@dash/contract';
import type { ContractCase } from './suite-server.js';

export interface ThemeSuiteOptions {
  /** Absolute path of the theme folder (`themes/<id>`). */
  themeDir: string;
}

/** Thrown by a case that has nothing to check; `runThemeContractSuite` reports it as skipped, not passed. */
export class ThemeCaseSkipped extends Error {}

const MODES: Mode[] = ['day', 'night'];
const INTENSITIES: Intensity[] = ['full', 'calm', 'static'];
const SUPPORTED_COLOURS = '#rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla(), or var(--db-...) pointing at one of those';

function fail(msg: string): never {
  throw new Error(msg);
}

function failAll(problems: string[]): void {
  if (problems.length > 0) fail(problems.join('\n'));
}

// ---------------------------------------------------------------------------------------- CSS reading

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function readCss(themeDir: string, file: string): string {
  return stripComments(readFileSync(path.join(themeDir, file), 'utf8'));
}

/** Declarations of every `:root[data-theme="<id>"][data-mode="<mode>"]` rule in the file, later rules winning. */
function tokenBlock(css: string, themeId: string, mode: Mode): Record<string, string> | null {
  let found = false;
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.replace(/["'\s]/g, ''));
    const want = `:root[data-theme=${themeId}][data-mode=${mode}]`;
    if (!selectors.some((s) => s === want)) continue;
    found = true;
    for (const d of (m[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[d[1] ?? ''] = (d[2] ?? '').trim();
  }
  return found ? out : null;
}

function themeTokens(themeDir: string, theme: ThemeManifest): Record<Mode, Record<string, string> | null> {
  const file = path.join(themeDir, 'tokens.css');
  if (!existsSync(file)) fail(`tokens.css not found in ${themeDir}`);
  const css = readCss(themeDir, 'tokens.css');
  return { day: tokenBlock(css, theme.id, 'day'), night: tokenBlock(css, theme.id, 'night') };
}

// ------------------------------------------------------------------------------------ colour contrast

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function parseAlpha(s: string | undefined): number {
  if (s === undefined || s === '') return 1;
  const t = s.trim();
  const n = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
  if (Number.isNaN(n)) throw new Error('bad alpha');
  return clamp(n, 0, 1);
}

function parseChannel(s: string): number {
  const t = s.trim();
  const n = t.endsWith('%') ? (parseFloat(t) / 100) * 255 : parseFloat(t);
  if (Number.isNaN(n)) throw new Error('bad channel');
  return clamp(n, 0, 255);
}

/** Hue in degrees, from a bare number or a `deg`, `grad`, `rad` or `turn` value. Throws when unparsable. */
function parseHue(s: string): number {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i.exec(s.trim());
  if (!m) throw new Error('bad hue');
  const n = parseFloat(m[1] ?? '');
  const unit = (m[2] ?? 'deg').toLowerCase();
  const deg = unit === 'turn' ? n * 360 : unit === 'rad' ? (n * 180) / Math.PI : unit === 'grad' ? n * 0.9 : n;
  return ((deg % 360) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Parses the supported colour syntaxes; throws on anything else. */
export function parseColour(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v)?.[1];
  if (hex !== undefined) {
    if (hex.length === 3 || hex.length === 4) {
      const [r = '0', g = '0', b = '0', a = 'f'] = [...hex];
      return {
        r: parseInt(r + r, 16),
        g: parseInt(g + g, 16),
        b: parseInt(b + b, 16),
        a: parseInt(a + a, 16) / 255,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    throw new Error('bad hex');
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/i.exec(v);
  if (fn) {
    const name = (fn[1] ?? '').toLowerCase();
    const parts = (fn[2] ?? '').split(/\s*[,/]\s*|\s+/).filter((p) => p !== '');
    if (parts.length < 3 || parts.length > 4) throw new Error('bad function arguments');
    const [p0 = '', p1 = '', p2 = '', p3] = parts;
    if (name.startsWith('rgb')) {
      return { r: parseChannel(p0), g: parseChannel(p1), b: parseChannel(p2), a: parseAlpha(p3) };
    }
    const h = parseHue(p0);
    const [r, g, b] = hslToRgb(h, clamp(parseFloat(p1), 0, 100) / 100, clamp(parseFloat(p2), 0, 100) / 100);
    if ([r, g, b].some(Number.isNaN)) throw new Error('bad hsl');
    return { r, g, b, a: parseAlpha(p3) };
  }
  throw new Error('unsupported syntax');
}

function resolveColour(token: string, tokens: Record<string, string>): Rgba {
  const raw = tokens[token];
  if (raw === undefined || raw === '') throw new Error(`${token} is not defined`);
  let value = raw;
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(raw);
  if (ref) {
    const target = tokens[ref[1] ?? ''];
    if (target === undefined) throw new Error(`${token} is ${raw}, but ${ref[1]} is not defined`);
    value = target;
  }
  try {
    return parseColour(value);
  } catch {
    throw new Error(`${token} has value "${raw}", which the suite cannot check; use ${SUPPORTED_COLOURS}`);
  }
}

function channelLum(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgba): number {
  return 0.2126 * channelLum(c.r) + 0.7152 * channelLum(c.g) + 0.0722 * channelLum(c.b);
}

/** WCAG 2.x contrast ratio of two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

// ----------------------------------------------------------------------------------- pending-work probe

/** Records requestAnimationFrame / setTimeout / setInterval calls that were neither run nor cleared. */
function installPendingProbe(): { pending: () => string[]; settle: () => Promise<void>; restore: () => void } {
  const g = globalThis as unknown as Record<string, (...a: unknown[]) => unknown>;
  const names = ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
  const originals = new Map<string, unknown>(names.map((n) => [n, g[n]]));
  const pending = new Map<unknown, string>();
  let rafId = 0;
  const orig = (n: string): ((...a: unknown[]) => unknown) => originals.get(n) as (...a: unknown[]) => unknown;

  g['requestAnimationFrame'] = () => {
    rafId += 1;
    pending.set(`raf:${rafId}`, 'requestAnimationFrame');
    return rafId;
  };
  g['cancelAnimationFrame'] = (id) => {
    pending.delete(`raf:${String(id)}`);
  };
  g['setTimeout'] = (cb, ...rest) => {
    const handle: unknown = orig('setTimeout')((...a: unknown[]) => {
      pending.delete(handle);
      return (cb as (...x: unknown[]) => unknown)(...a);
    }, ...rest);
    pending.set(handle, 'setTimeout');
    return handle;
  };
  g['clearTimeout'] = (h) => {
    pending.delete(h);
    return orig('clearTimeout')(h);
  };
  g['setInterval'] = (...a) => {
    const handle = orig('setInterval')(...a);
    pending.set(handle, 'setInterval');
    return handle;
  };
  g['clearInterval'] = (h) => {
    pending.delete(h);
    return orig('clearInterval')(h);
  };

  return {
    pending: () => [...pending.values()],
    // Two microtasks and one real zero-delay timer (the original, so it is not counted), so work a scene
    // schedules from a promise or a timer callback has happened before we judge.
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        orig('setTimeout')(resolve, 0);
      });
    },
    restore: () => {
      // Clear real timers we left running so the test process does not hang on them.
      for (const [h, kind] of pending) {
        if (kind === 'setTimeout') orig('clearTimeout')(h);
        if (kind === 'setInterval') orig('clearInterval')(h);
      }
      for (const [n, f] of originals) g[n] = f as (...a: unknown[]) => unknown;
    },
  };
}

// ---------------------------------------------------------------------------------------- file helpers

const SIGNATURES: Array<[string, (b: Buffer) => boolean]> = [
  ['WebP', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['AVIF', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /avi[fs]/.test(b.subarray(8, 32).toString('latin1'))],
  ['PNG', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['JPEG', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
];

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...svelteFiles(full));
    else if (name.endsWith('.svelte')) out.push(full);
  }
  return out;
}

// -------------------------------------------------------------------------------------------- SVG icons

const SVG_NS = 'http://www.w3.org/2000/svg';
const ALLOWED_ELEMENTS = new Set(
  ['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'title', 'desc', 'defs', 'clipPath', 'mask',
    'linearGradient', 'radialGradient', 'stop', 'use', 'symbol'].map((n) => n.toLowerCase()),
);
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'stop-color', 'color']);
const NEUTRAL_PAINT = /^(none|currentcolor|inherit|transparent|url\(\s*#[^)\s]+\s*\)|var\(\s*--db-[\w-]+\s*(,[^)]*)?\))$/i;

/** Parses the markup as XML and applies an element allow-list and attribute rules to every node. */
function iconProblems(svg: string): string[] {
  if (typeof DOMParser === 'undefined') {
    return ['theme tests need the jsdom environment (`// @vitest-environment jsdom`)'];
  }
  // The shell renders icons with the HTML parser, which reads comments, processing instructions and
  // declarations differently from XML, so none of them is allowed at all.
  const raw = rawMarkupProblems(svg);
  if (raw.length > 0) return raw;
  const problems: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svg.trim(), 'image/svg+xml');
  } catch (e) {
    return [`is not well-formed svg: ${e instanceof Error ? e.message : String(e)}`];
  }
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) return [`is not well-formed svg (a single <svg> root is required): ${(parserError.textContent ?? '').trim().split('\n')[0] ?? ''}`];
  const root = doc.documentElement;
  if (root.localName.toLowerCase() !== 'svg') return [`must be a single <svg> element (found <${root.localName}>)`];

  if (doc.doctype) problems.push('contains a doctype');
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const name = el.localName.toLowerCase();
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 8) problems.push('contains a comment');
      else if (node.nodeType === 7) problems.push('contains a processing instruction');
      else if (node.nodeType === 4) problems.push('contains a CDATA section');
      else if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '' && name !== 'title' && name !== 'desc') {
        problems.push(`<${el.localName}> contains text "${(node.textContent ?? '').trim()}"; text is only allowed in <title> and <desc>`);
      } else if (node.nodeType !== 1 && node.nodeType !== 3) problems.push(`contains a node of type ${node.nodeType}`);
    }
    const label = el.prefix ? `${el.prefix}:${el.localName}` : el.localName;
    if (el.prefix || (el.namespaceURI !== null && el.namespaceURI !== SVG_NS) || !ALLOWED_ELEMENTS.has(name)) {
      problems.push(`<${label}> is not allowed (allowed: ${[...ALLOWED_ELEMENTS].join(', ')})`);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const an = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (an.startsWith('on')) problems.push(`<${label}> has the event attribute ${attr.name}`);
      else if (an === 'style') problems.push(`<${label}> has a style attribute; use presentation attributes`);
      else if (an === 'href' || an.endsWith(':href')) {
        if (!/^#\S+$/.test(value)) problems.push(`<${label}> ${attr.name}="${value}" is not a #fragment`);
      } else if (PAINT_ATTRIBUTES.has(an)) {
        if (!NEUTRAL_PAINT.test(value)) {
          problems.push(`<${label}> has hard-coded ${an}="${value}"; use none, currentColor, url(#id) or var(--db-...)`);
        }
      } else if (/javascript:/i.test(value) || /url\(\s*['"]?(?!#)/i.test(value)) {
        problems.push(`<${label}> ${attr.name} refers to a script or an external url`);
      }
    }
  }
  if (problems.length > 0) return problems;
  // Defence in depth: what the browser's HTML parser makes of the original and of the re-serialised icon.
  return [...htmlCrossCheck(svg.trim()), ...htmlCrossCheck(new XMLSerializer().serializeToString(root))];
}

/** Parses markup with the HTML parser (as the shell's `{@html}` does) and reports unexpected elements or on* attributes. */
export function htmlCrossCheck(markup: string): string[] {
  const problems: string[] = [];
  const html = new DOMParser().parseFromString(markup, 'text/html');
  for (const el of Array.from(html.documentElement.querySelectorAll('*'))) {
    const name = el.localName.toLowerCase();
    if (name === 'head' || name === 'body') continue;
    if (!ALLOWED_ELEMENTS.has(name)) problems.push(`the HTML parser reads this icon as containing <${name}>, which is not allowed`);
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        problems.push(`the HTML parser reads this icon as having the event attribute ${attr.name} on <${name}>`);
      }
    }
  }
  return problems;
}

/** Checks on the raw string, before any parsing. */
function rawMarkupProblems(svg: string): string[] {
  const problems: string[] = [];
  if (/<!--/.test(svg)) problems.push('contains a comment');
  if (/<!\[CDATA\[/i.test(svg)) problems.push('contains a CDATA section');
  if (/<!doctype/i.test(svg)) problems.push('contains a doctype');
  if (/<!ENTITY|<!ELEMENT|<!ATTLIST/i.test(svg)) problems.push('contains an entity or other declaration');
  if (/<\?/.test(svg)) problems.push('contains a processing instruction (including the <?xml ... ?> prolog)');
  if (problems.length === 0 && /<!/.test(svg)) problems.push('contains a markup declaration (<!...)');
  return problems;
}

// -------------------------------------------------------------------------------------------- the cases

const identityT: Translate = (_key, fallback) => fallback;
const stubApi = {
  get: () => Promise.reject(new Error('api is not available in the theme contract suite')),
  post: () => Promise.reject(new Error('api is not available in the theme contract suite')),
  put: () => Promise.reject(new Error('api is not available in the theme contract suite')),
  patch: () => Promise.reject(new Error('api is not available in the theme contract suite')),
  delete: () => Promise.reject(new Error('api is not available in the theme contract suite')),
};

/** True when the face shows the hour and minute as visible text, or as the aria-label of a role="img" element. */
function exposesTime(container: HTMLElement, props: ClockFaceProps): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: props.timeZone }).formatToParts(props.now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const h24 = get('hour') % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(get('minute')).padStart(2, '0');
  const hours = [...new Set([h24, h12].flatMap((h) => [String(h), String(h).padStart(2, '0')]))];
  const re = new RegExp(`(?<!\\d)(?:${hours.join('|')})\\s?(?:[:.h]|\\s)\\s?${mm}(?!\\d)`, 'i');
  const texts = [container.textContent ?? '', ...[...container.querySelectorAll('[role="img"]')].map((el) => el.getAttribute('aria-label') ?? '')];
  return texts.some((t) => re.test(t));
}

const FIXED_NOW = new Date('2026-06-21T14:05:09.000Z');
const FIXED_ENV: SceneEnv = { sunAltitudeDeg: 35, weather: 'clear', moonPhase: 0.25, now: FIXED_NOW };

export function themeContractCases(theme: ThemeManifest, opts: ThemeSuiteOptions): ContractCase[] {
  const { themeDir } = opts;
  const repoRoot = path.resolve(themeDir, '..', '..');

  const cssFiles = (): string[] => theme.css.map((f) => f);
  const readManifestCss = (): Array<{ file: string; text: string }> =>
    cssFiles().map((file) => {
      if (!existsSync(path.join(themeDir, file))) fail(`manifest.css lists "${file}", which does not exist in ${themeDir}`);
      return { file, text: readCss(themeDir, file) };
    });
  /** Manifest css plus the `<style>` blocks of the theme's own `.svelte` files (`file` is relative to the theme folder). */
  const readAllSheets = (): Array<{ file: string; text: string }> => {
    const sheets = readManifestCss();
    for (const f of svelteFiles(themeDir)) {
      const styles = [...readFileSync(f, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => stripComments(m[1] ?? ''));
      if (styles.length > 0) sheets.push({ file: path.relative(themeDir, f), text: styles.join('\n') });
    }
    return sheets;
  };

  return [
    {
      name: 'manifest is valid',
      run: () => {
        failAll(validateTheme(theme));
        return Promise.resolve();
      },
    },
    {
      name: 'tokens.css defines every REQUIRED_TOKENS for day and night',
      run: () => {
        const blocks = themeTokens(themeDir, theme);
        const problems: string[] = [];
        for (const mode of MODES) {
          const block = blocks[mode];
          if (!block) {
            problems.push(`tokens.css has no :root[data-theme="${theme.id}"][data-mode="${mode}"] rule`);
            continue;
          }
          const missing = REQUIRED_TOKENS.filter((t) => (block[t] ?? '') === '');
          if (missing.length > 0) problems.push(`${mode}: missing or empty ${missing.join(', ')}`);
        }
        failAll(problems);
        return Promise.resolve();
      },
    },
    {
      name: 'contrast pairs meet minimums in both modes',
      run: () => {
        const blocks = themeTokens(themeDir, theme);
        const problems: string[] = [];
        for (const mode of MODES) {
          const tokens = blocks[mode];
          if (!tokens) {
            problems.push(`${mode}: no token block`);
            continue;
          }
          for (const [fgToken, bgToken, min] of CONTRAST_PAIRS) {
            try {
              const bg = resolveColour(bgToken, tokens);
              if (bg.a < 1) throw new Error(`${bgToken} must be opaque`);
              const fg = over(resolveColour(fgToken, tokens), bg);
              const ratio = contrastRatio(fg, bg);
              if (ratio < min) {
                problems.push(`${mode}: ${fgToken} on ${bgToken} is ${ratio.toFixed(2)}:1, needs at least ${min}:1`);
              }
            } catch (e) {
              problems.push(`${mode}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        failAll(problems);
        return Promise.resolve();
      },
    },
    {
      name: 'every background has a static image file',
      run: () => {
        const problems: string[] = [];
        for (const bg of theme.backgrounds) {
          const file = path.resolve(themeDir, bg.staticImage);
          if (!isInside(themeDir, file) || !existsSync(file) || !statSync(file).isFile()) {
            problems.push(`background "${bg.id}": ${bg.staticImage} does not exist in the theme folder`);
            continue;
          }
          const bytes = readFileSync(file);
          if (bytes.length === 0) problems.push(`background "${bg.id}": ${bg.staticImage} is empty`);
          else if (!SIGNATURES.some(([, ok]) => ok(bytes))) {
            problems.push(`background "${bg.id}": ${bg.staticImage} is not a WebP, AVIF, PNG or JPEG file`);
          }
        }
        failAll(problems);
        return Promise.resolve();
      },
    },
    {
      name: 'each clock face renders at 2×1 and 6×4',
      run: async () => {
        for (const face of theme.clockFaces) {
          const Face = (await face.component()).default;
          for (const size of [{ w: 2, h: 1 }, { w: 6, h: 4 }]) {
            for (const mode of MODES) {
              for (const showSeconds of [true, false]) {
                for (const hour12 of [true, false]) {
                  const props: ClockFaceProps = {
                    now: FIXED_NOW,
                    mode,
                    size,
                    showSeconds,
                    hour12,
                    timeZone: 'Asia/Kolkata',
                    label: 'Test',
                  };
                  const what = `clock face "${face.id}" at ${size.w}x${size.h} (${mode}, seconds ${String(showSeconds)}, 12h ${String(hour12)})`;
                  try {
                    const { container } = render(Face, { props });
                    if (container.innerHTML.trim() === '') fail(`${what} rendered nothing`);
                    if (!exposesTime(container, props)) {
                      fail(`${what} does not expose the time as text: render visible text with the hour and minute, or role="img" with an aria-label containing them`);
                    }
                  } catch (e) {
                    fail(e instanceof Error && e.message.startsWith('clock face') ? e.message : `${what} threw: ${String(e)}`);
                  } finally {
                    cleanup();
                  }
                }
              }
            }
          }
        }
      },
    },
    {
      name: 'each background renders in full, calm, static without throwing',
      run: async () => {
        const problems: string[] = [];
        for (const bg of theme.backgrounds) {
          const Scene = (await bg.component()).default;
          for (const intensity of INTENSITIES) {
            for (const mode of MODES) {
              const what = `background "${bg.id}" (${intensity}, ${mode})`;
              const probe = installPendingProbe();
              try {
                const props: BackgroundProps = { mode, intensity, env: FIXED_ENV };
                render(Scene, { props });
                flushSync();
                await probe.settle();
                if (intensity === 'static' && probe.pending().length > 0) {
                  problems.push(`${what} animates at static: pending ${probe.pending().join(', ')}`);
                }
                cleanup();
                flushSync();
                await probe.settle();
                const left = probe.pending();
                if (left.length > 0) problems.push(`${what} leaks after unmount: pending ${left.join(', ')}`);
              } catch (e) {
                problems.push(`${what} threw: ${String(e)}`);
              } finally {
                cleanup();
                probe.restore();
              }
            }
          }
        }
        failAll(problems);
      },
    },
    {
      name: "every tile override renders with that module's tile fixture",
      run: async () => {
        const entries = Object.entries(theme.tiles ?? {});
        if (entries.length === 0) throw new ThemeCaseSkipped('theme has no tile overrides');
        let rendered = 0;
        for (const [moduleId, load] of entries) {
          const fixture = path.join(repoRoot, 'modules', moduleId, 'fixtures', 'tile.json');
          if (!existsSync(fixture)) continue;
          const data: unknown = JSON.parse(readFileSync(fixture, 'utf8'));
          const Tile = (await load()).default;
          for (const mode of MODES) {
            const props: TileProps = {
              data,
              updatedAt: '2026-01-01T12:00:00.000Z',
              stale: false,
              settings: {},
              level: 'edit',
              size: { w: 4, h: 2 },
              mode,
              api: stubApi,
              locale: 'de-DE',
              timeZone: 'Asia/Kolkata',
              t: identityT,
              openDetail: () => undefined,
            };
            try {
              const { container } = render(Tile, { props });
              if (container.innerHTML.trim() === '') fail(`tile override for "${moduleId}" rendered nothing (${mode})`);
              rendered += 1;
            } finally {
              cleanup();
            }
          }
        }
        if (rendered === 0) throw new ThemeCaseSkipped('no overridden module has a fixtures/tile.json');
      },
    },
    {
      name: 'css contains no @import and no url() to another origin',
      run: () => {
        const problems: string[] = [];
        for (const { file, text } of readAllSheets()) {
          if (/@import\b/i.test(text)) problems.push(`${file}: @import is not allowed; list the file in manifest.css instead`);
          for (const m of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gis)) {
            const url = (m[2] ?? '').trim();
            if (url.startsWith('#')) continue;
            if (/^data:/i.test(url)) problems.push(`${file}: data: URL is not allowed (the Content-Security-Policy blocks it for fonts)`);
            else if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) problems.push(`${file}: url(${url}) points to another origin`);
            else if (url.startsWith('/')) problems.push(`${file}: url(${url}) must be relative to the css file`);
          }
        }
        failAll(problems);
        return Promise.resolve();
      },
    },
    {
      name: 'fonts referenced exist in the theme folder',
      run: () => {
        const problems: string[] = [];
        for (const { file, text } of readAllSheets()) {
          for (const face of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
            const body = face[1] ?? '';
            const display = /font-display\s*:\s*([\w-]+)/i.exec(body)?.[1]?.toLowerCase();
            if (display !== 'swap' && display !== 'optional') {
              problems.push(`${file}: @font-face needs font-display: swap or optional (found ${display ?? 'none'})`);
            }
            for (const u of body.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gis)) {
              const url = (u[2] ?? '').split(/[?#]/)[0] ?? '';
              if (/^(data:|[a-z][a-z0-9+.-]*:|\/)/i.test(url)) {
                problems.push(`${file}: font url(${url}) must be a relative file in the theme folder`);
                continue;
              }
              const target = path.resolve(themeDir, path.dirname(file), url);
              if (!isInside(themeDir, target) || !existsSync(target) || !statSync(target).isFile()) {
                problems.push(`${file}: font ${url} does not exist inside the theme folder`);
              } else if (readFileSync(target).subarray(0, 4).toString('latin1') !== 'wOF2') {
                problems.push(`${file}: font ${url} is not a WOFF2 file`);
              }
            }
          }
        }
        failAll(problems);
        return Promise.resolve();
      },
    },
    {
      name: 'icons are safe svg',
      run: () => {
        const problems: string[] = [];
        for (const [key, svg] of Object.entries(theme.icons)) {
          if (typeof svg !== 'string' || svg.trim() === '') {
            problems.push(`icon "${key}" is not a non-empty string`);
            continue;
          }
          for (const p of iconProblems(svg)) problems.push(`icon "${key}": ${p}`);
        }
        failAll(problems);
        return Promise.resolve();
      },
    },
    {
      name: 'honours reduced motion',
      run: () => {
        const problems: string[] = [];
        for (const { file, text } of readAllSheets()) {
          const moves = /(?:^|[;{\s])(?:animation|transition)(?:-[a-z-]+)?\s*:/i.test(text);
          const guarded = /@media[^{]*prefers-reduced-motion\s*:\s*reduce/i.test(text);
          if (moves && !guarded) problems.push(`${file}: has animation/transition but no @media (prefers-reduced-motion: reduce) block`);
        }
        failAll(problems);
        return Promise.resolve();
      },
    },
  ];
}

/** Registers the theme contract cases with Vitest. Call from the theme's `tests/theme.test.ts`. */
export function runThemeContractSuite(theme: ThemeManifest, opts: ThemeSuiteOptions): void {
  for (const c of themeContractCases(theme, opts)) {
    test(c.name, async (ctx) => {
      try {
        await c.run();
      } catch (e) {
        if (e instanceof ThemeCaseSkipped) ctx.skip(e.message);
        throw e;
      }
    });
  }
}
