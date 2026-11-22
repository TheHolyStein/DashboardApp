// Fix round 2: non-element nodes and XML/HTML parser differentials in theme icons.
import { describe, expect, test } from 'vitest';
import type { ThemeManifest } from '@dash/contract';
import { htmlCrossCheck, themeContractCases } from '../src/suite-theme.js';
import { icons as defaultIcons } from '../../../themes/default/icons.js';
import good from './sample-theme/good/theme.js';
import path from 'node:path';

const GOOD_DIR = path.join(import.meta.dirname, 'sample-theme', 'good');
const name = 'icons are safe svg';
const NS = 'xmlns="http://www.w3.org/2000/svg"';

async function run(icons: ThemeManifest['icons']): Promise<string> {
  const c = themeContractCases({ ...good, icons }, { themeDir: GOOD_DIR }).find((x) => x.name === name);
  try {
    await c!.run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

describe('non-element nodes in icons', () => {
  test('every Default theme icon still passes', async () => {
    expect(await run(defaultIcons)).toBe('');
  });

  test.each([
    ['empty comment hiding an img for the html parser', `<svg ${NS}><!--><img src=x onerror=alert(1)>--></svg>`, 'comment'],
    ['plain comment', `<svg ${NS}><!-- hi --><path d="M1 1"/></svg>`, 'comment'],
    ['processing instruction hiding an img', `<svg ${NS}><?x ><img src=x onerror=alert(1)> ?></svg>`, 'processing instruction'],
    ['xml prolog', `<?xml version="1.0"?><svg ${NS}><path d="M1 1"/></svg>`, 'processing instruction'],
    ['CDATA section', `<svg ${NS}><desc><![CDATA[<img src=x onerror=alert(1)>]]></desc></svg>`, 'CDATA'],
    ['doctype with an internal entity', `<!DOCTYPE svg [<!ENTITY e "x">]><svg ${NS}><desc>&e;</desc></svg>`, 'doctype'],
    ['entity declaration', `<svg ${NS}><!ENTITY e "x"><path d="M1 1"/></svg>`, 'declaration'],
    ['text outside title and desc', `<svg ${NS}>hello<path d="M1 1"/></svg>`, 'text'],
    ['text inside a group', `<svg ${NS}><g>hello</g></svg>`, 'text'],
  ])('%s is rejected with a message naming the node kind', async (_what, svg, kind) => {
    expect(await run({ settings: svg })).toContain(kind);
  });

  test('text inside title and desc, and whitespace anywhere, pass', async () => {
    const svg = `<svg ${NS} viewBox="0 0 24 24">\n  <title>Settings</title>\n  <desc>A gear</desc>\n  <g>\n    <path d="M1 1"/>\n  </g>\n</svg>`;
    expect(await run({ settings: svg })).toBe('');
  });
});

describe('html parser cross-check', () => {
  test('a clean svg gives no problems', () => {
    expect(htmlCrossCheck(`<svg ${NS}><path d="M1 1"/><linearGradient id="g"><stop/></linearGradient></svg>`)).toEqual([]);
  });
  test('an extra element the html parser creates is reported', () => {
    const problems = htmlCrossCheck(`<svg ${NS}><path d="M1 1"/></svg><img src=x>`);
    expect(problems.join()).toContain('<img>');
  });
  test('an on* attribute the html parser creates is reported', () => {
    expect(htmlCrossCheck(`<svg ${NS}><path d="M1 1" onload="x()"/></svg>`).join()).toContain('onload');
  });
});

describe('environment', () => {
  test('without DOMParser the case says what to do', async () => {
    const saved = globalThis.DOMParser;
    // @ts-expect-error simulating a theme test without the jsdom environment
    globalThis.DOMParser = undefined;
    try {
      expect(await run({ settings: `<svg ${NS}/>` })).toContain('@vitest-environment jsdom');
    } finally {
      globalThis.DOMParser = saved;
    }
  });
});
