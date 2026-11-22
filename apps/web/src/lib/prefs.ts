import { MeDto, type Intensity } from '@dash/contract';
import type { z } from 'zod';
import { api } from './api.js';
import { session } from './session.svelte.js';

type Me = z.infer<typeof MeDto>;
export type Prefs = Me['prefs'];
export type ModePolicy = Prefs['modePolicy'];

/** PATCH the user's preferences; the answer replaces the session's user so every reader follows. */
export async function savePrefs(patch: Partial<Prefs>): Promise<Me> {
  const me = await api.patch('/me/prefs', patch, MeDto);
  session.me = me;
  return me;
}

/** The order the top bar's quick toggle cycles through. */
export const MODE_CYCLE: readonly ModePolicy[] = ['day', 'night', 'system', 'sun'];
export function nextMode(p: ModePolicy): ModePolicy {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(p) + 1) % MODE_CYCLE.length] ?? 'day';
}

// ---- remembered on this device (localStorage; every access may throw or be empty) ----
const THEME_KEY = 'dash:last-theme';
const INTENSITY_KEY = 'dash:intensity';
const POLICIES: readonly string[] = MODE_CYCLE;
const INTENSITIES: readonly string[] = ['full', 'calm', 'static'];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

/** The last theme id and mode policy used on this device, so the sign-in screen can be themed. */
export function rememberTheme(prefs: Pick<Prefs, 'theme' | 'modePolicy'>): void {
  write(THEME_KEY, JSON.stringify({ theme: prefs.theme, modePolicy: prefs.modePolicy }));
}
export function recallTheme(): Pick<Prefs, 'theme' | 'modePolicy'> {
  const fallback = { theme: 'default', modePolicy: 'system' as ModePolicy };
  try {
    const raw = read(THEME_KEY);
    const v = raw ? (JSON.parse(raw) as { theme?: unknown; modePolicy?: unknown }) : null;
    return {
      theme: typeof v?.theme === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(v.theme) ? v.theme : fallback.theme,
      modePolicy: typeof v?.modePolicy === 'string' && POLICIES.includes(v.modePolicy) ? (v.modePolicy as ModePolicy) : fallback.modePolicy,
    };
  } catch {
    return fallback;
  }
}

/** The per-device animation intensity override; `null` = automatic. */
export function loadIntensityOverride(): Intensity | null {
  const v = read(INTENSITY_KEY);
  return v !== null && INTENSITIES.includes(v) ? (v as Intensity) : null;
}
export function storeIntensityOverride(v: Intensity | null): void {
  write(INTENSITY_KEY, v);
}
