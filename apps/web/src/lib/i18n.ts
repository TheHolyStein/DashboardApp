import type { Translate } from '@dash/contract';

/** Replace `{var}` placeholders; unknown variables are left as written. */
export function interpolate(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : text;
}

let localeStrings: Record<string, string> = {};
let overlay: ((key: string) => string | undefined) | null = null;

/** Strings of the active app locale (a later German locale plugs in here). */
export function setLocaleStrings(strings: Record<string, string>): void {
  localeStrings = strings;
}
export function lookupLocale(key: string): string | undefined {
  return Object.hasOwn(localeStrings, key) ? localeStrings[key] : undefined;
}
/** A string source consulted before the locale strings (the theme engine installs its theme strings here). */
export function setStringOverlay(fn: ((key: string) => string | undefined) | null): void {
  overlay = fn;
}

/** Translate `key`: overlay (theme) strings, then locale strings, then the fallback; with `{var}` interpolation. */
export const t: Translate = (key, fallback, vars) => interpolate(overlay?.(key) ?? lookupLocale(key) ?? fallback, vars);
