import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { ThemeManifest } from '@dash/contract';
import { themeContractCases, ThemeCaseSkipped } from '../src/suite-theme.js';
import good from './sample-theme/good/theme.js';
import RafAtStatic from './sample-theme/negative/RafAtStatic.svelte';
import Leaky from './sample-theme/negative/Leaky.svelte';
import Tidy from './sample-theme/negative/Tidy.svelte';
import Throws from './sample-theme/negative/Throws.svelte';
import FaceNoText from './sample-theme/negative/FaceNoText.svelte';
import FaceLabelled from './sample-theme/negative/FaceLabelled.svelte';

const GOOD_DIR = path.join(import.meta.dirname, 'sample-theme', 'good');
const BROKEN_TOKENS = path.join(import.meta.dirname, 'sample-theme', 'broken', 'tokens.css');
const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Copies the good theme to a temp folder, lets `edit` change it, and returns the folder. */
function variant(edit: (dir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-theme-'));
  tmpDirs.push(dir);
  cpSync(GOOD_DIR, dir, { recursive: true });
  edit(dir);
  return dir;
}

async function failedCases(theme: ThemeManifest, themeDir: string): Promise<string[]> {
  const failed: string[] = [];
  for (const c of themeContractCases(theme, { themeDir })) {
    try {
      await c.run();
    } catch (e) {
      if (!(e instanceof ThemeCaseSkipped)) failed.push(c.name);
    }
  }
  return failed;
}

async function messageOf(theme: ThemeManifest, themeDir: string, name: string): Promise<string> {
  const c = themeContractCases(theme, { themeDir }).find((x) => x.name === name);
  if (!c) throw new Error(`no case ${name}`);
  try {
    await c.run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

const withScene = (component: ThemeManifest['backgrounds'][number]['component']): ThemeManifest => ({
  ...good,
  backgrounds: [{ ...good.backgrounds[0]!, component }],
});

describe('theme contract cases', () => {
  test('case names are the documented ones', () => {
    expect(themeContractCases(good, { themeDir: GOOD_DIR }).map((c) => c.name)).toEqual([
      'manifest is valid',
      'tokens.css defines every REQUIRED_TOKENS for day and night',
      'contrast pairs meet minimums in both modes',
      'every background has a static image file',
      'each clock face renders at 2×1 and 6×4',
      'each background renders in full, calm, static without throwing',
      "every tile override renders with that module's tile fixture",
      'css contains no @import and no url() to another origin',
      'fonts referenced exist in the theme folder',
      'icons are safe svg',
      'honours reduced motion',
    ]);
  });

  test('good sample passes every case (tile overrides skipped)', async () => {
    expect(await failedCases(good, GOOD_DIR)).toEqual([]);
    const tiles = themeContractCases(good, { themeDir: GOOD_DIR }).find((c) => c.name.startsWith('every tile override'));
    await expect(tiles!.run()).rejects.toBeInstanceOf(ThemeCaseSkipped);
  });

  test('broken fixture fails exactly the tokens and contrast cases', async () => {
    const dir = variant((d) => cpSync(BROKEN_TOKENS, path.join(d, 'tokens.css')));
    expect(await failedCases(good, dir)).toEqual([
      'tokens.css defines every REQUIRED_TOKENS for day and night',
      'contrast pairs meet minimums in both modes',
    ]);
    expect(await messageOf(good, dir, 'tokens.css defines every REQUIRED_TOKENS for day and night')).toContain('day: missing or empty --db-radius');
    expect(await messageOf(good, dir, 'contrast pairs meet minimums in both modes')).toMatch(/night: --db-fg on --db-bg is \d\.\d\d:1/);
  });

  test('manifest problems are reported', async () => {
    expect(await failedCases({ ...good, pane: { ...good.pane, durationMs: 900 } }, GOOD_DIR)).toEqual(['manifest is valid']);
  });

  describe('contrast colour syntaxes', () => {
    const set = (token: string, value: string) => (d: string) => {
      appendFileSync(
        path.join(d, 'tokens.css'),
        `\n:root[data-theme="sample"][data-mode="day"] { ${token}: ${value}; }\n`,
      );
    };
    const name = 'contrast pairs meet minimums in both modes';

    test.each([
      ['#000', '--db-fg'],
      ['rgb(0, 0, 0)', '--db-fg'],
      ['rgb(0 0 0 / 100%)', '--db-fg'],
      ['hsl(0, 0%, 0%)', '--db-fg'],
      ['hsla(220deg 10% 8% / 1)', '--db-fg'],
      ['#000000ee', '--db-fg'],
      ['var(--db-focus)', '--db-accent'],
    ])('%s is understood for %s', async (value, token) => {
      const dir = variant(set(token, value));
      expect(await messageOf(good, dir, name)).toBe('');
    });

    test('translucent text is composited over the background', async () => {
      const dir = variant(set('--db-fg', '#00000040'));
      expect(await messageOf(good, dir, name)).toMatch(/day: --db-fg on --db-bg/);
    });

    test.each(['linear-gradient(#000, #111)', 'color-mix(in srgb, red, blue)', 'black', 'var(--db-nope)'])(
      '%s is rejected with a message naming the token and the supported syntaxes',
      async (value) => {
        const dir = variant(set('--db-fg', value));
        const msg = await messageOf(good, dir, name);
        expect(msg).toContain('--db-fg');
        if (!value.startsWith('var(')) expect(msg).toContain('#rrggbbaa');
        else expect(msg).toContain('--db-nope');
      },
    );
  });

  describe('static images', () => {
    const name = 'every background has a static image file';
    test('missing', async () => {
      const dir = variant((d) => rmSync(path.join(d, 'background', 'plain.webp')));
      expect(await failedCases(good, dir)).toEqual([name]);
    });
    test('empty', async () => {
      const dir = variant((d) => writeFileSync(path.join(d, 'background', 'plain.webp'), ''));
      expect(await messageOf(good, dir, name)).toContain('is empty');
    });
    test('wrong signature', async () => {
      const dir = variant((d) => writeFileSync(path.join(d, 'background', 'plain.webp'), 'GIF89a not allowed'));
      expect(await messageOf(good, dir, name)).toContain('not a WebP, AVIF, PNG or JPEG');
    });
    test('path escaping the theme folder', async () => {
      const bad = { ...good, backgrounds: [{ ...good.backgrounds[0]!, staticImage: '../broken/tokens.css' }] };
      expect(await failedCases(bad, GOOD_DIR)).toContain(name);
    });
  });

  describe('css rules', () => {
    const name = 'css contains no @import and no url() to another origin';
    const add = (css: string) => (d: string) => appendFileSync(path.join(d, 'tokens.css'), `\n${css}\n`);
    const cases: Array<[string, string, string]> = [
      ['@import', '@import "./more.css";', '@import'],
      ['@import url', '@import url(https://x.test/a.css);', '@import'],
      ['remote url', '.a { background: url(https://x.test/a.png); }', 'another origin'],
      ['protocol-relative url', '.a { background: url("//x.test/a.png"); }', 'another origin'],
      ['root-relative url', ".a { background: url('/a.png'); }", 'relative'],
      ['data url', '.a { background: url(data:image/png;base64,AAAA); }', 'data:'],
    ];
    test.each(cases)('%s fails only the css case', async (_what, css, expected) => {
      const dir = variant(add(css));
      expect(await failedCases(good, dir)).toEqual([name]);
      expect(await messageOf(good, dir, name)).toContain(expected);
    });
    test('relative url and a #fragment url pass', async () => {
      const dir = variant(add('.a { background: url(./background/plain.webp); mask: url(#m); }'));
      expect(await failedCases(good, dir)).toEqual([]);
    });
    test('urls inside comments are ignored', async () => {
      const dir = variant(add('/* @import url(https://x.test/a.css); */'));
      expect(await failedCases(good, dir)).toEqual([]);
    });
  });

  describe('fonts', () => {
    const name = 'fonts referenced exist in the theme folder';
    const face = (extra: string) => `@font-face { font-family: X; src: url(./fonts/x.woff2) format("woff2"); ${extra} }`;
    const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(16)]);
    const withFont = (css: string, bytes: Buffer | null) => (d: string) => {
      appendFileSync(path.join(d, 'tokens.css'), `\n${css}\n`);
      if (bytes) {
        mkdirSync(path.join(d, 'fonts'));
        writeFileSync(path.join(d, 'fonts', 'x.woff2'), bytes);
      }
    };
    test('valid font passes', async () => {
      expect(await failedCases(good, variant(withFont(face('font-display: swap;'), woff2)))).toEqual([]);
    });
    test('missing file', async () => {
      expect(await messageOf(good, variant(withFont(face('font-display: swap;'), null)), name)).toContain('does not exist');
    });
    test('not woff2', async () => {
      expect(await messageOf(good, variant(withFont(face('font-display: swap;'), Buffer.from('OTTO0000'))), name)).toContain('not a WOFF2');
    });
    test('font-display missing', async () => {
      expect(await messageOf(good, variant(withFont(face(''), woff2)), name)).toContain('font-display');
    });
    test('data: font fails the css case and the font case', async () => {
      const css = '@font-face { font-family: X; font-display: swap; src: url(data:font/woff2;base64,AAAA); }';
      const dir = variant(withFont(css, null));
      expect(await failedCases(good, dir)).toEqual([
        'css contains no @import and no url() to another origin',
        name,
      ]);
    });
  });

  describe('icons', () => {
    const name = 'icons are safe svg';
    const icon = (inner: string, attrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor"') =>
      `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
    const withIcon = (svg: string): ThemeManifest => ({ ...good, icons: { settings: svg } });
    test('currentColor line icon passes', async () => {
      expect(await failedCases(withIcon(icon('<path d="M3 3h18"/><circle cx="12" cy="12" r="3"/>')), GOOD_DIR)).toEqual([]);
    });
    test('token variables pass', async () => {
      expect(await failedCases(withIcon(icon('<path d="M3 3h18" stroke="var(--db-accent)"/>')), GOOD_DIR)).toEqual([]);
    });
    test.each([
      ['<script>', icon('<script>alert(1)</script><path d="M3 3"/>'), '<script>'],
      ['on* attribute', icon('<path d="M3 3" onclick="x()"/>'), 'event attribute'],
      ['external href', icon('<use href="https://x.test/a.svg#a"/>'), 'href'],
      ['xlink:href', icon('<use xlink:href="//x.test/a.svg#a"/>'), 'well-formed'],
      ['foreignObject', icon('<foreignObject><div/></foreignObject>'), 'foreignObject'],
      ['hard-coded colour on the root', icon('<path d="M3 3"/>', 'viewBox="0 0 24 24" stroke="#ff0000"'), 'stroke="#ff0000"'],
      ['hard-coded colour on every path', icon('<path d="M3 3" fill="red"/><path d="M4 4" stroke="#00f"/>'), 'fill="red"'],
      ['two roots', icon('<path d="M3 3"/>') + icon('<path d="M3 3"/>'), 'well-formed'],
      ['not svg', '<div>x</div>', 'single <svg>'],
    ])('%s fails', async (_what, svg, expected) => {
      const theme = withIcon(svg);
      expect(await failedCases(theme, GOOD_DIR)).toEqual([name]);
      expect(await messageOf(theme, GOOD_DIR, name)).toContain(expected);
    });
    test('a fragment href passes', async () => {
      expect(await failedCases(withIcon(icon('<defs><path id="a" d="M3 3"/></defs><use href="#a"/>')), GOOD_DIR)).toEqual([]);
    });
  });

  describe('reduced motion', () => {
    const name = 'honours reduced motion';
    const add = (css: string) => (d: string) => appendFileSync(path.join(d, 'tokens.css'), `\n${css}\n`);
    test('animation without a reduced-motion block fails', async () => {
      const dir = variant((d) => writeFileSync(path.join(d, 'tokens.css'), '.a { animation: spin 1s infinite; }'));
      expect(await messageOf({ ...good }, dir, name)).toContain('tokens.css');
    });
    test('transition in a svelte style block without the media query fails', async () => {
      const dir = variant((d) =>
        appendFileSync(path.join(d, 'clock', 'Digital.svelte'), '\n<style>.x { transition: color 1s; }</style>\n'),
      );
      expect(await messageOf(good, dir, name)).toContain('Digital.svelte');
    });
    test('guarded animation passes', async () => {
      const dir = variant(add('.a { animation: spin 1s; } @media (prefers-reduced-motion: reduce) { .a { animation: none; } }'));
      expect(await messageOf(good, dir, name)).toBe('');
    });
  });

  describe('scenes', () => {
    const name = 'each background renders in full, calm, static without throwing';
    test('tidy scene passes', async () => {
      expect(await messageOf(withScene(() => Promise.resolve({ default: Tidy })), GOOD_DIR, name)).toBe('');
    });
    test('a frame left pending at static is reported, with the leak', async () => {
      const msg = await messageOf(withScene(() => Promise.resolve({ default: RafAtStatic })), GOOD_DIR, name);
      expect(msg).toContain('animates at static');
      expect(msg).toContain('leaks after unmount');
    });
    test('an interval that survives unmount is a leak', async () => {
      const msg = await messageOf(withScene(() => Promise.resolve({ default: Leaky })), GOOD_DIR, name);
      expect(msg).toContain('(full, day) leaks after unmount');
      expect(msg).not.toContain('animates at static');
    });
    test('a scene that throws is reported', async () => {
      const msg = await messageOf(withScene(() => Promise.resolve({ default: Throws })), GOOD_DIR, name);
      expect(msg).toContain('threw');
      expect(msg).toContain('night');
    });
  });

  describe('clock faces expose the time as text', () => {
    const name = 'each clock face renders at 2×1 and 6×4';
    const withFace = (component: unknown): ThemeManifest => ({
      ...good,
      clockFaces: [{ id: 'x', name: 'X', component: () => Promise.resolve({ default: component as never }) }],
    });
    test('visible text with hour and minute passes (the good Digital face)', async () => {
      expect(await messageOf(good, GOOD_DIR, name)).toBe('');
    });
    test('role="img" with an aria-label containing hour and minute passes', async () => {
      expect(await messageOf(withFace(FaceLabelled), GOOD_DIR, name)).toBe('');
    });
    test('an image-like face without the time as text fails', async () => {
      expect(await messageOf(withFace(FaceNoText), GOOD_DIR, name)).toContain('does not expose the time as text');
    });
  });
});
