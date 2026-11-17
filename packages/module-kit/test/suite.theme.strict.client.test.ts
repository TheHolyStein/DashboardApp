// Fix round 1: numeric colour tests and the stricter icon / css / scene readers.
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { ThemeManifest } from '@dash/contract';
import { contrastRatio, over, parseColour, themeContractCases, ThemeCaseSkipped } from '../src/suite-theme.js';
import { icons as defaultIcons } from '../../../themes/default/icons.js';
import good from './sample-theme/good/theme.js';
import LateRaf from './sample-theme/negative/LateRaf.svelte';
import LateTimer from './sample-theme/negative/LateTimer.svelte';

const GOOD_DIR = path.join(import.meta.dirname, 'sample-theme', 'good');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

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

describe('colour maths', () => {
  const white = parseColour('#ffffff');
  const near = (c: { r: number; g: number; b: number }, rgb: [number, number, number], tol = 1): void => {
    expect(Math.abs(c.r - rgb[0])).toBeLessThanOrEqual(tol);
    expect(Math.abs(c.g - rgb[1])).toBeLessThanOrEqual(tol);
    expect(Math.abs(c.b - rgb[2])).toBeLessThanOrEqual(tol);
  };

  test('contrast ratio values', () => {
    expect(contrastRatio(parseColour('#000'), white)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColour('#777777'), white)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(parseColour('#767676'), white)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(white, parseColour('#777777'))).toBeCloseTo(4.48, 2);
  });

  test.each([
    '#369',
    '#336699',
    '#336699ff',
    '#369f',
    'rgb(51 102 153)',
    'rgb(51, 102, 153)',
    'rgba(51, 102, 153, 1)',
    'rgb(51 102 153 / 100%)',
    'rgb(20% 40% 60%)',
    'hsl(210 50% 40%)',
    'hsl(210, 50%, 40%)',
    'hsla(210deg 50% 40% / 1)',
    'hsl(0.58333turn 50% 40%)',
    'hsl(3.66519rad 50% 40%)',
    'hsl(233.3333grad 50% 40%)',
    'hsl(-150 50% 40%)',
    'hsl(570 50% 40%)',
  ])('%s is #336699', (value) => {
    const c = parseColour(value);
    near(c, [51, 102, 153]);
    expect(c.a).toBeCloseTo(1, 5);
  });

  test('alpha is composited over the background, not under it', () => {
    const c = over(parseColour('#33669980'), white);
    const a = 128 / 255;
    near(c, [51 * a + 255 * (1 - a), 102 * a + 255 * (1 - a), 153 * a + 255 * (1 - a)]);
    near(over(parseColour('hsla(210 50% 40% / 0.5)'), parseColour('#000000')), [25.5, 51, 76.5]);
  });

  test.each(['hsl(blue 50% 40%)', 'hsl(NaNdeg 50% 40%)', 'hsl(10foo 50% 40%)', 'rgb(1 2)', '#12', 'red'])(
    '%s does not parse',
    (value) => {
      expect(() => parseColour(value)).toThrow();
    },
  );

  describe('through the contrast case, at the 4.5 boundary', () => {
    const name = 'contrast pairs meet minimums in both modes';
    const day = (fg: string) => (d: string) =>
      appendFileSync(
        path.join(d, 'tokens.css'),
        `\n:root[data-theme="sample"][data-mode="day"] { --db-bg: #ffffff; --db-surface: #ffffff; --db-fg: ${fg}; }\n`,
      );
    test('#767676 on white passes', async () => {
      expect(await messageOf(good, variant(day('#767676')), name)).toBe('');
    });
    test('#777777 on white fails with its ratio', async () => {
      expect(await messageOf(good, variant(day('#777777')), name)).toContain('day: --db-fg on --db-bg is 4.48:1');
    });
    test('hsl(210 50% 40%) behaves like #336699', async () => {
      const hex = await messageOf(good, variant(day('#336699')), name);
      const hsl = await messageOf(good, variant(day('hsl(210 50% 40%)')), name);
      expect(hsl).toBe(hex);
    });
  });
});

describe('selector matching', () => {
  const tokensName = 'tokens.css defines every REQUIRED_TOKENS for day and night';
  const rewrite = (to: string) => (d: string) => {
    const file = path.join(d, 'tokens.css');
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll(':root[data-theme="sample"][data-mode="night"]', to));
  };
  test('a rule that merely contains the root selector does not count', async () => {
    const dir = variant(rewrite('.x :root[data-theme="sample"][data-mode="night"] .y'));
    expect(await messageOf(good, dir, tokensName)).toContain('no :root[data-theme="sample"][data-mode="night"] rule');
  });
  test('whitespace and quote style do not matter', async () => {
    expect(await failedCases(good, variant(rewrite(":root[data-theme='sample']  [data-mode = 'night']")))).toEqual([]);
  });
});

describe('css cases scan svelte style blocks too', () => {
  const style = (css: string) => (d: string) =>
    appendFileSync(path.join(d, 'clock', 'Digital.svelte'), `\n<style>${css}</style>\n`);
  const origin = 'css contains no @import and no url() to another origin';
  test('remote url in a component style', async () => {
    const dir = variant(style('.x { background: url(https://x.test/a.png); }'));
    expect(await messageOf(good, dir, origin)).toContain('Digital.svelte');
  });
  test('@import in a component style', async () => {
    expect(await messageOf(good, variant(style('@import "x.css";')), origin)).toContain('Digital.svelte');
  });
  test('data: font in a component style', async () => {
    const dir = variant(style('@font-face { font-family: X; font-display: swap; src: url(data:font/woff2;base64,AAAA); }'));
    expect(await messageOf(good, dir, 'fonts referenced exist in the theme folder')).toContain('Digital.svelte');
  });
});

describe('scene probe settles before judging', () => {
  const name = 'each background renders in full, calm, static without throwing';
  test('a frame requested in a microtask after mount is seen at static', async () => {
    const msg = await messageOf(withScene(() => Promise.resolve({ default: LateRaf })), GOOD_DIR, name);
    expect(msg).toContain('animates at static');
  });
  test('an interval started from a setTimeout(0) after mount is a leak', async () => {
    const msg = await messageOf(withScene(() => Promise.resolve({ default: LateTimer })), GOOD_DIR, name);
    expect(msg).toContain('leaks after unmount');
  });
});

describe('icons are parsed as svg', () => {
  const name = 'icons are safe svg';
  const NS = 'xmlns="http://www.w3.org/2000/svg"';
  const wrap = (inner: string, attrs = `${NS} viewBox="0 0 24 24" fill="none" stroke="currentColor"`): string =>
    `<svg ${attrs}>${inner}</svg>`;
  const withIcon = (svg: string): ThemeManifest => ({ ...good, icons: { settings: svg } });

  test('every Default theme icon passes', async () => {
    expect(await failedCases({ ...good, icons: defaultIcons }, GOOD_DIR)).toEqual([]);
  });

  test('a fragment reference and token paint pass', async () => {
    const svg = wrap(
      '<defs><path id="a" d="M3 3h18"/></defs><use href="#a"/><path d="M1 1" fill="var(--db-accent)" stroke="url(#g)"/>',
    );
    expect(await failedCases(withIcon(svg), GOOD_DIR)).toEqual([]);
  });

  test.each([
    ['upper-case SCRIPT', wrap('<SCRIPT>alert(1)</SCRIPT><path d="M3 3"/>'), 'script'],
    ['slash before attribute', `<svg ${NS}><path/onload=alert(1)></svg>`, ''],
    ['no space before attribute', wrap('<path d="x"onclick="alert(1)"/>'), ''],
    ['on* attribute, any case', wrap('<path d="M3 3" OnLoad="alert(1)"/>'), 'onload'],
    ['slash before href', wrap('<use/href="https://x.test/a.svg#a"/>'), ''],
    ['unquoted href', wrap('<use href=https://x.test/a.svg#a/>'), ''],
    ['external href', wrap('<use href="https://x.test/a.svg#a"/>'), 'href'],
    ['xlink:href to another file', wrap('<use xlink:href="a.svg#a" xmlns:xlink="http://www.w3.org/1999/xlink"/>'), 'href'],
    ['entity-encoded javascript:', wrap('<use href="&#106;avascript:alert(1)"/>'), 'href'],
    ['<style> element', wrap('<style>@import url(https://x.test/a.css); path{fill:red}</style><path d="M3 3"/>'), 'style'],
    ['style attribute', wrap('<path d="M3 3" style="fill:red"/>'), 'style'],
    ['style attribute with url', wrap('<path d="M3 3" style="background:url(https://x.test/a.png)"/>'), 'style'],
    ['<image href>', wrap('<image href="#a"/>'), 'image'],
    ['<a href>', wrap('<a href="#a"><path d="M3 3"/></a>'), '<a>'],
    ['<foreignObject>', wrap('<foreignObject><div/></foreignObject>'), 'foreignobject'],
    ['<animate> on href', wrap('<use href="#a"/><animate attributeName="href" to="javascript:alert(1)"/>'), 'animate'],
    ['<set> on href', wrap('<use href="#a"/><set attributeName="href" to="javascript:alert(1)"/>'), 'set'],
    ['one hard-coded path next to a currentColor one', wrap('<path d="M3 3"/><path d="M4 4" fill="red"/>'), 'fill'],
    ['hard-coded stroke on a group', wrap('<g stroke="#00f"><path d="M3 3"/></g>'), 'stroke'],
    ['hard-coded stop-color', wrap('<defs><linearGradient id="g"><stop stop-color="#f00"/></linearGradient></defs>'), 'stop-color'],
    ['two roots', wrap('<path d="M3 3"/>') + wrap('<path d="M3 3"/>'), ''],
    ['not svg', '<div>x</div>', 'svg'],
    ['prefixed element', wrap('<x:path xmlns:x="http://www.w3.org/1999/xhtml"/>'), 'x:path'],
  ])('%s is rejected', async (_what, svg, expected) => {
    const theme = withIcon(svg);
    expect(await failedCases(theme, GOOD_DIR), svg).toEqual([name]);
    expect((await messageOf(theme, GOOD_DIR, name)).toLowerCase()).toContain(expected);
  });
});
