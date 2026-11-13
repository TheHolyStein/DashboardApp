import type { Translate } from '@dash/contract';

/** Translate `key`; for now returns the fallback with `{var}` interpolation. Themes/locales plug in later. */
export const t: Translate = (_key, fallback, vars) =>
  vars ? fallback.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : fallback;
