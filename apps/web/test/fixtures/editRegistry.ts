import type { ModuleClient } from '@dash/contract';
import { z } from 'zod';
import type { EditRegistry } from '../../src/lib/schema-form.js';
import CustomSettings from './CustomSettings.svelte';
import Detail from './Detail.svelte';
import GoodTile from './GoodTile.svelte';

const tile = { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 4, h: 3 } };

export const clockSettings = z.object({
  title: z.string().min(1).meta({ label: 'Title', help: 'Shown in the header' }),
  refresh: z.number().int().min(1).max(60).default(5),
  zone: z.string().optional().meta({ widget: 'timezone' }),
});
export const feedSettings = z.object({
  token: z.string().min(1).meta({ label: 'Token', widget: 'secret' }),
  feeds: z.array(z.object({ url: z.url().meta({ label: 'URL' }), title: z.string().optional() })).default([]),
  mode: z.enum(['list', 'grid']).default('list'),
  compact: z.boolean().default(false),
});
export const weirdSettings = z.object({ pair: z.tuple([z.string(), z.number()]) });
export const customSettings = z.object({ text: z.string().default('') });

type Spec = { id: string; name: string; description: string; multi: boolean; settings: z.ZodObject; custom?: boolean };
const specs: Spec[] = [
  { id: 'clock', name: 'Clock', description: 'Time and date', multi: false, settings: clockSettings },
  { id: 'feeds', name: 'Feeds', description: 'News from RSS', multi: true, settings: feedSettings },
  { id: 'weird', name: 'Weird', description: 'Odd settings', multi: true, settings: weirdSettings },
  { id: 'custom', name: 'Custom', description: 'Own settings UI', multi: true, settings: customSettings, custom: true },
];

/** Registry with the full manifest fields the settings dialog and catalog read. */
export function editRegistry(only?: string[]): EditRegistry {
  const out: EditRegistry = {};
  for (const s of specs) {
    if (only && !only.includes(s.id)) continue;
    const manifest = { id: s.id, name: s.name, description: s.description, icon: 'clock', multiInstance: s.multi, tile, settings: s.settings };
    const client = {
      manifest,
      Tile: GoodTile,
      Detail,
      ...(s.custom ? { Settings: CustomSettings } : {}),
    } as unknown as ModuleClient;
    out[s.id] = { manifest, load: () => Promise.resolve({ default: client }) };
  }
  return out;
}
