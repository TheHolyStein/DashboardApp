import { z } from 'zod';
import { defineManifest } from '@dash/module-kit';

/** Per-instance settings. The `.meta()` blocks drive the generated settings form. */
export const settings = z.object({
  face: z.string().default('').meta({ label: 'Clock face', help: 'Empty = theme default' }),
  timeZone: z.string().default('').meta({ label: 'Time zone', widget: 'timezone', help: 'Empty = your time zone' }),
  label: z.string().max(40).default(''),
  showSeconds: z.boolean().default(false),
  hour12: z.boolean().default(false),
  showDate: z.boolean().default(true),
  showNextEvent: z.boolean().default(true),
});
export type Settings = z.infer<typeof settings>;

/** What the server pushes to each placed instance (per owner, not module-wide). */
export type Snapshot = {
  timers: Array<{ id: string; label: string; endsAt: string; durationSec: number }>;
  nextEvent: { title: string; start: string } | null;
};

export default defineManifest({
  id: 'clock',
  name: 'Clock',
  description: 'Time in any zone, countdown timers and the next calendar event.',
  version: '0.1.0',
  icon: 'clock',
  scope: 'user',
  multiInstance: true,
  tile: { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 6, h: 4 } },
  settings,
  config: z.object({}),
  levels: ['view', 'edit'],
  jobs: [{ name: 'tick', intervalSec: 5, mode: 'always', per: 'module' }],
  publishes: ['timer.finished'],
  subscribes: ['calendar.event.upcoming'],
  outbound: [],
});
