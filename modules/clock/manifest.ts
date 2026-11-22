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

type WireTimer = { id: string; label: string; endsAt: string; durationSec: number };

/**
 * What the server pushes to each placed instance (per owner, not module-wide). `rev` is the data owner's
 * revision: it rises with every change to their timers or next event. `epoch` names the server boot: a client
 * applies data from a new epoch always (a restart wins even if `rev` is lower) and, within one epoch, only
 * data at least as new as the newest it has seen.
 */
export type Snapshot = {
  epoch: string;
  rev: number;
  timers: WireTimer[];
  nextEvent: { title: string; start: string } | null;
};

/** The body of `GET /timers`, `POST /timers` and `DELETE /timers/:id`: the caller's full list at `{ epoch, rev }`. */
export type TimerList = { epoch: string; rev: number; timers: WireTimer[] };

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
