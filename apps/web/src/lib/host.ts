
import { THEME_CONTEXT_KEY, type InstanceDto, type Mode, type ModuleClient, type ModuleId, type ModuleManifest, type ThemeSeam } from '@dash/contract';
import type { z } from 'zod';
import { moduleApi } from './api.js';
import { t } from './i18n.js';
import { session } from './session.svelte.js';
import { stream } from './stream.svelte.js';

type Instance = z.infer<typeof InstanceDto>;

/** Registry entry as the hosts need it: the generated `clientModules` satisfies this; test registries may omit `load`. */
export interface HostEntry {
  manifest: Pick<ModuleManifest, 'id' | 'name' | 'tile'> & { icon?: string };
  load?: () => Promise<{ default: ModuleClient }>;
}
export type HostRegistry = Record<ModuleId, HostEntry>;

/** Kept for existing importers; the key and the seam type live in `@dash/contract`. */
export const THEME_KEY = THEME_CONTEXT_KEY;
export type { ThemeSeam };

export interface LoadedClient {
  client: ModuleClient;
}

/** Load the module's client code (once per module; theme overrides are resolved separately by the tile host). */
export async function loadClient(entry: HostEntry | undefined): Promise<LoadedClient> {
  if (!entry?.load) throw new Error('module client unavailable');
  return { client: (await entry.load()).default };
}

/** Access level the user holds on a module; anything but an explicit `view` or `edit` is no access. */
export function grantLevel(grants: Record<string, string> | undefined, moduleId: string): 'view' | 'edit' | null {
  const g = grants && Object.hasOwn(grants, moduleId) ? grants[moduleId] : undefined;
  return g === 'view' || g === 'edit' ? g : null;
}

/** Icon source for a module: theme icons win; module icons only by own key (no inherited `constructor` etc.). */
export function lookupIcon(theme: ThemeSeam | undefined, moduleIcons: Record<string, string>, name: string): string | undefined {
  return theme?.icon?.(name) ?? (Object.hasOwn(moduleIcons, name) ? moduleIcons[name] : undefined);
}

/** The part of Tile/Detail props that is the same for both. */
export function baseProps(instance: Instance, mode: Mode) {
  const snap = stream.snapshots[instance.id];
  return {
    data: snap?.data,
    updatedAt: snap?.updatedAt ?? null,
    stale: snap?.stale ?? false,
    settings: instance.settings,
    level: grantLevel(session.me?.grants, instance.moduleId) === 'edit' ? ('edit' as const) : ('view' as const),
    mode,
    api: moduleApi(instance.moduleId),
    t,
  };
}
