import { z } from 'zod';
import { defineManifest } from '@dash/module-kit';

/** No settings: the greeting and "today" follow the user's own time zone (`host.users()`). */
export const settings = z.object({});
export type Settings = z.infer<typeof settings>;

export type WeatherHint = {
  key: 'rainAt' | 'dry' | 'hot' | 'frost' | 'storm' | 'pollenHigh';
  vars: Record<string, string | number>;
};

export type HouseholdAlertKind = 'netOffline' | 'nasDegraded' | 'nasFailed';
/** `kind` is set for household conditions: `title` is then empty and the client renders `kind` + `vars` through `t()`. */
export type AlertView = { level: 'warn' | 'critical'; title: string; kind?: HouseholdAlertKind; vars?: { detail?: string } };
/** `key` is the pin's `sourceKey`: unique per user, so it is the client's list key (titles may repeat). */
export type PinView = { key: string; title: string };

/** What `compose` returns: the briefing of one user at one moment. Every section may be absent (empty or null). */
export type Briefing = {
  greeting: 'morning' | 'day' | 'evening' | 'night';
  date: string;
  next: { title: string; start: string; minutesUntil: number } | null;
  eventsToday: number;
  todos: { due: Array<{ title: string; list: string }>; overdue: number };
  weatherHint: WeatherHint | null;
  pins: PinView[];
  alerts: AlertView[];
};

/** What the server pushes to a user's instance. `epoch` names the server boot, `rev` rises with every change of the briefing. */
export type Snapshot = Briefing & { epoch: string; rev: number };

export type AgendaEvent = { uid: string; title: string; start: string; end: string; allDay: boolean };

/** The body of `GET /day`: the caller's agenda for today and tomorrow plus all due todos, at `{ epoch, rev }`. */
export type DayDetail = {
  epoch: string;
  rev: number;
  date: string;
  today: AgendaEvent[];
  tomorrow: AgendaEvent[];
  todos: { due: Array<{ title: string; list: string }>; overdue: number };
  alerts: AlertView[];
};

export default defineManifest({
  id: 'briefing',
  name: 'Briefing',
  description: 'Your day in one glance: next event, due todos, weather hint, pins and alerts.',
  version: '0.1.0',
  icon: 'note',
  scope: 'user',
  multiInstance: false,
  tile: { default: { w: 6, h: 2 }, min: { w: 3, h: 1 }, max: { w: 12, h: 4 } },
  settings,
  config: z.object({}),
  levels: ['view'],
  jobs: [{ name: 'compose', intervalSec: 60, mode: 'whenViewed', per: 'module' }],
  publishes: [],
  subscribes: [
    'calendar.day.summary',
    'calendar.event.upcoming',
    'todo.day.summary',
    'weather.updated',
    'pin.request',
    'notification.created',
    'net.connectivity.changed',
    'nas.health.changed',
  ],
  outbound: [],
});
