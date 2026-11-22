// Client-side entry (`@dash/module-kit/client`). Needs the jsdom environment and the Svelte compiler;
// see `moduleVitestConfig` from `@dash/module-kit/vitest`.
import { test } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import type { DetailProps, Mode, ModuleApi, ModuleClient, TileProps, TileSize, Translate } from '@dash/contract';
import { loadFixture } from './fixtures.js';
import type { ContractCase } from './suite-server.js';

export interface ClientSuiteOptions {
  moduleDir: string;
  tileFixture: string;
  detailFixture?: string;
}

/** Explicit, non-default values: a tile that ignores `locale` / `timeZone` (formats with the browser's or UTC) shows up as a wrong string. */
export const SUITE_LOCALE = 'de-DE';
export const SUITE_TIME_ZONE = 'Asia/Kolkata';

const MARK_OPEN = '⟦';
const MARK_CLOSE = '⟧';

const stubApi: ModuleApi = {
  get: () => Promise.reject(new Error('api.get is not available in the contract suite')),
  post: () => Promise.reject(new Error('api.post is not available in the contract suite')),
  put: () => Promise.reject(new Error('api.put is not available in the contract suite')),
  patch: () => Promise.reject(new Error('api.patch is not available in the contract suite')),
  delete: () => Promise.reject(new Error('api.delete is not available in the contract suite')),
};

/** Same behaviour as the shell's fallback translator: the fallback with `{name}` replaced from `vars`. */
const identityT: Translate = (_key, fallback, vars) =>
  vars ? fallback.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : fallback;
/** Marks the key; the fallback and its vars are replaced by the marker, so interpolated text is never mistaken for bare text. */
const markedT: Translate = (key) => `${MARK_OPEN}${key}${MARK_CLOSE}`;

function fail(msg: string): never {
  throw new Error(msg);
}

function collectStrings(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** Two or more words of three or more letters: a sentence, not a formatted value ("Thu 12:30 PM", "3.5 km" do not match). */
const PROSE = /\p{L}{3,}\s+\p{L}{3,}/u;

/**
 * Visible text nodes. Text inside a `data-value` element is data (formatted numbers, times, dates) and is skipped,
 * unless it reads as prose: that is reported separately as an offender by the caller. Text inside a `data-user`
 * element is user-provided content (titles, labels the user typed, feed headlines) and is exempt from both rules.
 */
function textNodes(root: Node): Array<{ text: string; dataValue: boolean }> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Array<{ text: string; dataValue: boolean }> = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim();
    if (!text) continue;
    if (n.parentElement?.closest('[data-user]') != null) continue;
    out.push({ text, dataValue: n.parentElement?.closest('[data-value]') != null });
  }
  return out;
}

export function clientContractCases(client: ModuleClient, opts: ClientSuiteOptions): ContractCase[] {
  const { manifest } = client;
  const tileData: unknown = loadFixture(opts.moduleDir, opts.tileFixture);
  const detailData: unknown = loadFixture(opts.moduleDir, opts.detailFixture ?? opts.tileFixture);
  const settingsParse = manifest.settings.safeParse({});
  const settings: unknown = settingsParse.success ? settingsParse.data : {};

  const tileProps = (over: Partial<TileProps> = {}): TileProps => ({
    data: tileData,
    updatedAt: '2026-01-01T12:00:00.000Z',
    stale: false,
    settings,
    level: 'edit',
    size: manifest.tile.default,
    mode: 'day',
    api: stubApi,
    t: identityT,
    locale: SUITE_LOCALE,
    timeZone: SUITE_TIME_ZONE,
    isOwner: true,
    instanceId: 'suite-instance',
    openDetail: () => undefined,
    ...over,
  });
  const detailProps = (over: Partial<DetailProps> = {}): DetailProps => ({
    data: detailData,
    updatedAt: '2026-01-01T12:00:00.000Z',
    stale: false,
    settings,
    level: 'edit',
    mode: 'day',
    api: stubApi,
    t: identityT,
    locale: SUITE_LOCALE,
    timeZone: SUITE_TIME_ZONE,
    isOwner: true,
    instanceId: 'suite-instance',
    params: {},
    close: () => undefined,
    ...over,
  });

  /** Renders, checks something was drawn, then unmounts. Returns the container for further checks via `inspect`. */
  const renderTile = (props: TileProps, inspect?: (container: HTMLElement) => void): void => {
    try {
      const { container } = render(client.Tile, { props });
      inspect?.(container);
    } finally {
      cleanup();
    }
  };
  const renderDetail = (props: DetailProps, inspect?: (container: HTMLElement) => void): void => {
    try {
      const { container } = render(client.Detail, { props });
      inspect?.(container);
    } finally {
      cleanup();
    }
  };
  const nonEmpty = (what: string) => (container: HTMLElement) => {
    if (container.innerHTML.trim() === '') fail(`${what} rendered nothing`);
  };

  const tokenize = (s: string): string[] =>
    s
      .split(/\s+/)
      .map((w) => w.replace(/[\p{P}\p{S}\d]/gu, '').toLowerCase())
      .filter((w) => w !== '');
  // Whole tokens only: a hard-coded "no" must not pass because the fixture contains "north".
  const fixtureTokens = new Set(
    [...collectStrings(tileData, []), ...collectStrings(detailData, [])].flatMap(tokenize),
  );
  const checkTexts = (what: string, container: HTMLElement): void => {
    const offenders: string[] = [];
    for (const { text, dataValue } of textNodes(container)) {
      if (dataValue) {
        if (PROSE.test(text)) offenders.push(`${what}: data-value text reads as prose, use t() for "${text}"`);
        continue;
      }
      const leftover = text.replace(new RegExp(`${MARK_OPEN}[^${MARK_CLOSE}]*${MARK_CLOSE}`, 'g'), ' ');
      const bare = tokenize(leftover).filter((w) => !fixtureTokens.has(w));
      if (bare.length > 0) offenders.push(`${what}: "${text}"`);
    }
    if (offenders.length > 0) fail(`text not passed through t(): ${offenders.join('; ')}`);
  };
  const checkNoEdit = (what: string, container: HTMLElement): void => {
    if (container.querySelector('[data-edit]')) fail(`${what} shows [data-edit] controls at level view or when the user is not the owner`);
  };

  return [
    {
      name: 'tile renders with fixture data',
      run: () => {
        for (const mode of ['day', 'night'] as Mode[]) renderTile(tileProps({ mode }), nonEmpty(`tile (${mode})`));
        renderTile(tileProps({ isOwner: false }), nonEmpty('tile (not owner)'));
        return Promise.resolve();
      },
    },
    {
      name: 'tile renders with data undefined',
      run: () => {
        renderTile(tileProps({ data: undefined, updatedAt: null }), nonEmpty('tile with undefined data'));
        return Promise.resolve();
      },
    },
    {
      name: 'tile renders stale state',
      run: () => {
        renderTile(tileProps({ stale: true }), nonEmpty('stale tile'));
        return Promise.resolve();
      },
    },
    {
      name: 'tile renders at min and max size',
      run: () => {
        for (const size of [manifest.tile.min, manifest.tile.max] as TileSize[]) {
          renderTile(tileProps({ size }), nonEmpty(`tile at ${size.w}x${size.h}`));
        }
        return Promise.resolve();
      },
    },
    {
      name: 'detail renders with fixture data',
      run: () => {
        renderDetail(detailProps(), nonEmpty('detail'));
        renderDetail(detailProps({ isOwner: false }), nonEmpty('detail (not owner)'));
        return Promise.resolve();
      },
    },
    {
      name: 'all visible text goes through t()',
      run: () => {
        const states: Array<[string, Partial<TileProps>]> = [
          ['tile', {}],
          ['tile (data undefined)', { data: undefined, updatedAt: null }],
          ['tile (stale)', { stale: true }],
        ];
        for (const [what, over] of states) renderTile(tileProps({ t: markedT, ...over }), (c) => checkTexts(what, c));
        renderDetail(detailProps({ t: markedT }), (c) => checkTexts('detail', c));
        renderDetail(detailProps({ t: markedT, data: undefined, updatedAt: null }), (c) =>
          checkTexts('detail (data undefined)', c),
        );
        renderDetail(detailProps({ t: markedT, stale: true }), (c) => checkTexts('detail (stale)', c));
        renderDetail(detailProps({ t: markedT, isOwner: false }), (c) => checkTexts('detail (not owner)', c));
        return Promise.resolve();
      },
    },
    {
      name: 'view level shows no edit controls',
      run: () => {
        renderTile(tileProps({ level: 'view' }), (c) => checkNoEdit('tile', c));
        renderDetail(detailProps({ level: 'view' }), (c) => checkNoEdit('detail', c));
        // A viewer on a shared page may hold the edit grant; the instance still is not theirs.
        renderTile(tileProps({ isOwner: false }), (c) => checkNoEdit('tile (not owner)', c));
        renderDetail(detailProps({ isOwner: false }), (c) => checkNoEdit('detail (not owner)', c));
        return Promise.resolve();
      },
    },
  ];
}

/** Registers the seven client contract cases with Vitest. Call from `*.client.test.ts` / `tests/client.test.ts`. */
export function runClientContractSuite(client: ModuleClient, opts: ClientSuiteOptions): void {
  for (const c of clientContractCases(client, opts)) test(c.name, c.run);
}
