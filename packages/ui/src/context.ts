import { ICONS_CONTEXT_KEY, T_CONTEXT_KEY, type Translate } from '@dash/contract';
import { getContext } from 'svelte';

/** Svelte context key under which the shell provides the `t` function. */
export const T_KEY = T_CONTEXT_KEY;
/** Svelte context key for the icon source: `(name) => svg string | undefined`. */
export const ICONS_KEY = ICONS_CONTEXT_KEY;

export type IconSource = (name: string) => string | undefined;

/** Identity-fallback translation with `{var}` interpolation; used when no shell provides `dash:t`. */
export const identityT: Translate = (_key, fallback, vars) =>
  vars ? fallback.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : fallback;

/** Call during component initialisation. */
export function useT(): Translate {
  return getContext<Translate | undefined>(T_KEY) ?? identityT;
}

/** Call during component initialisation. */
export function useIcons(): IconSource | undefined {
  return getContext<IconSource | undefined>(ICONS_KEY);
}
