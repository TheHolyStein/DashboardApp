import { readFileSync } from 'node:fs';

/** Replaced by esbuild's `define` in the production bundle (see build.mjs). */
declare const __DASH_VERSION__: string | undefined;

/** The server's version: inlined at build time in the bundle, read from package.json from source. */
export const SERVER_VERSION: string =
  typeof __DASH_VERSION__ === 'string'
    ? __DASH_VERSION__
    : (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
