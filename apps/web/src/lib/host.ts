
import type { ChartPalette, InstanceDto, Mode, ModuleClient, ModuleId, ModuleManifest, TileSize } from '@dash/contract';
import type { Component } from 'svelte';
import type { z } from 'zod';
import { moduleApi } from './api.js';
import { t } from './i18n.js';
import { session } from './session.svelte.js';
import { stream } from './stream.svelte.js';

type Instance = z.infer<typeof InstanceDto>;
type TileComponent = ModuleClient['Tile'];

/** Registry entry as the hosts need it: the generated `clientModules` satisfies this; test registries may omit `load`. */
export interface HostEntry {
  manifest: Pick<ModuleManifest, 'id' | 'name' | 'tile'> & { icon?: string };
  load?: () => Promise<{ default: ModuleClient }>;
}
export type HostRegistry = Record<ModuleId, HostEntry>;

/** Svelte context key for the theme seam. The theme engine provides it; absent means no theme overrides. */
export const THEME_KEY = 'dash:theme';
export interface ThemeSeam {
  /** A full tile replacement for the module at this size (theme `minSize` rules apply), or null to use the module's own tile. */
  tileFor(moduleId: ModuleId, size?: TileSize): Promise<TileComponent | null>;
  /** Identity of the active theme; reactive when present, so a theme switch re-resolves overrides. */
  readonly id?: string;
  clockFace?: (id?: string) => Promise<Component<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- face props are the theme's contract
  chart?: () => ChartPalette;
  /** Current colour mode; read inside reactive code, so a getter keeps it live. */
  readonly mode?: Mode;
  /** Theme icon source; wins over module-provided icons for the same name. */
  icon?: (name: string) => string | undefined;
}

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
