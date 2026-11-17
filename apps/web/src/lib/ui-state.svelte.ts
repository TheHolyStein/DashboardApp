/** Shell UI state that several components share (kept out of `.svelte` module scripts). */

/** Which instance's settings are open. Set by the tile's settings button. */
export const settingsUi = $state<{ instanceId: string | null }>({ instanceId: null });
export function openSettings(instanceId: string): void {
  settingsUi.instanceId = instanceId;
}

/** Whether the module catalog is open. Set by the edit bar. */
export const catalogUi = $state<{ open: boolean }>({ open: false });

/** The settings area (account, appearance, admin). Mirrored in the URL as `?s=<section>`. */
export const SETTINGS_SECTIONS = ['account', 'appearance', 'pages', 'users', 'grants', 'modules', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const isSection = (v: string | null): v is SettingsSection => v !== null && (SETTINGS_SECTIONS as readonly string[]).includes(v);

export interface SettingsAreaDeps {
  history: Pick<History, 'pushState' | 'replaceState' | 'back'>;
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  window: { addEventListener(type: 'popstate', fn: () => void): void };
}

export function createSettingsArea(deps: SettingsAreaDeps) {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- short-lived parser, not state
  const params = (): URLSearchParams => new URLSearchParams(deps.location.search);
  const read = (): SettingsSection | null => {
    const v = params().get('s');
    return isSection(v) ? v : null;
  };
  let section = $state<SettingsSection | null>(read());
  let pushed = false;

  const urlWith = (next: SettingsSection | null): string => {
    const q = params();
    if (next) q.set('s', next);
    else q.delete('s');
    const s = q.toString();
    return `${deps.location.pathname}${s ? `?${s}` : ''}${deps.location.hash}`;
  };
  const sync = (): void => {
    section = read();
    if (!section) pushed = false;
  };
  deps.window.addEventListener('popstate', sync);

  return {
    get section(): SettingsSection | null {
      return section;
    },
    get open(): boolean {
      return section !== null;
    },
    /** Open the area (pushes one history entry) or switch section (replaces it). */
    show(next: SettingsSection = 'account'): void {
      if (section) deps.history.replaceState(null, '', urlWith(next));
      else {
        deps.history.pushState(null, '', urlWith(next));
        pushed = true;
      }
      section = next;
    },
    /** Close: Back when this session pushed the entry, otherwise replace the URL. */
    close(): void {
      if (!section) return;
      if (pushed) deps.history.back(); // popstate updates the state
      else {
        deps.history.replaceState(null, '', urlWith(null));
        section = null;
      }
    },
    sync,
  };
}

export const settingsArea = createSettingsArea({ history: window.history, location: window.location, window });
