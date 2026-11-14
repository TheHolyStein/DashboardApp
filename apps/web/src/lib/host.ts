
import type { InstanceDto, Mode, ModuleClient, ModuleId, ModuleManifest } from '@dash/contract';
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
  /** A full tile replacement for the module, or null to use the module's own tile. */
  tileFor(moduleId: ModuleId): Promise<TileComponent | null>;
  /** Current colour mode; read inside reactive code, so a getter keeps it live. */
  readonly mode?: Mode;
  /** Theme icon source; wins over module-provided icons for the same name. */
  icon?: (name: string) => string | undefined;
}

export interface LoadedClient {
  client: ModuleClient;
  override: TileComponent | null;
}

/** Load the module's client code; with `withOverride`, also resolve the theme's tile override (a failing seam means no override). */
export async function loadClient(entry: HostEntry | undefined, theme: ThemeSeam | undefined, withOverride: boolean): Promise<LoadedClient> {
  if (!entry?.load) throw new Error('module client unavailable');
  const client = (await entry.load()).default;
  let override: TileComponent | null = null;
  if (withOverride && theme) {
    try {
      override = await theme.tileFor(entry.manifest.id);
    } catch {
      override = null;
    }
  }
  return { client, override };
}

/** The part of Tile/Detail props that is the same for both. */
export function baseProps(instance: Instance, mode: Mode) {
  const snap = stream.snapshots[instance.id];
  return {
    data: snap?.data,
    updatedAt: snap?.updatedAt ?? null,
    stale: snap?.stale ?? false,
    settings: instance.settings,
    level: session.me?.grants[instance.moduleId] === 'edit' ? ('edit' as const) : ('view' as const),
    mode,
    api: moduleApi(instance.moduleId),
    t,
  };
}
