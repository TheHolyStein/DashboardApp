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

const MARK_OPEN = '⟦';
const MARK_CLOSE = '⟧';

const stubApi: ModuleApi = {
  get: () => Promise.reject(new Error('api.get is not available in the contract suite')),
  post: () => Promise.reject(new Error('api.post is not available in the contract suite')),
  put: () => Promise.reject(new Error('api.put is not available in the contract suite')),
  patch: () => Promise.reject(new Error('api.patch is not available in the contract suite')),
  delete: () => Promise.reject(new Error('api.delete is not available in the contract suite')),
};

const identityT: Translate = (_key, fallback) => fallback;
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

function textNodes(root: Node): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim();
    if (text) out.push(text);
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
    for (const text of textNodes(container)) {
      const leftover = text.replace(new RegExp(`${MARK_OPEN}[^${MARK_CLOSE}]*${MARK_CLOSE}`, 'g'), ' ');
      const bare = tokenize(leftover).filter((w) => !fixtureTokens.has(w));
      if (bare.length > 0) offenders.push(`${what}: "${text}"`);
    }
    if (offenders.length > 0) fail(`text not passed through t(): ${offenders.join('; ')}`);
  };
  const checkNoEdit = (what: string, container: HTMLElement): void => {
    if (container.querySelector('[data-edit]')) fail(`${what} shows [data-edit] controls at level view`);
  };

  return [
    {
      name: 'tile renders with fixture data',
      run: () => {
        for (const mode of ['day', 'night'] as Mode[]) renderTile(tileProps({ mode }), nonEmpty(`tile (${mode})`));
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
        return Promise.resolve();
      },
    },
    {
      name: 'view level shows no edit controls',
      run: () => {
        renderTile(tileProps({ level: 'view' }), (c) => checkNoEdit('tile', c));
        renderDetail(detailProps({ level: 'view' }), (c) => checkNoEdit('detail', c));
        return Promise.resolve();
      },
    },
  ];
}

/** Registers the seven client contract cases with Vitest. Call from `*.client.test.ts` / `tests/client.test.ts`. */
export function runClientContractSuite(client: ModuleClient, opts: ClientSuiteOptions): void {
  for (const c of clientContractCases(client, opts)) test(c.name, c.run);
}
