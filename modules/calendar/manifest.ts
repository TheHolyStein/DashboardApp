import { z } from 'zod';
import { defineManifest } from '@dash/module-kit';

/** Per-instance settings (one tile = one view of some calendars). */
export const settings = z.object({
  /** Empty = every calendar the viewer can see. */
  calendarIds: z.array(z.string()).default([]).meta({ label: 'Calendars', help: 'Empty = all visible calendars' }),
  defaultView: z.enum(['agenda', 'day', 'week', 'month']).default('agenda').meta({ label: 'Default view' }),
  weekStart: z.enum(['mon', 'sun']).default('mon').meta({ label: 'Week starts on' }),
  daysAhead: z.number().int().min(1).max(14).default(3).meta({ label: 'Days ahead in the agenda' }),
});
export type Settings = z.infer<typeof settings>;

/** Module-wide admin config. */
export const config = z.object({
  /** Minutes before an event for the default reminder; 0 = no default reminder. */
  defaultReminderMin: z.number().int().min(0).max(10080).default(0).meta({ label: 'Default reminder (minutes, 0 = none)' }),
  /** How far ahead derived items (todos, pins, countdowns) are created. */
  deriveHorizonDays: z.number().int().min(1).max(365).default(14).meta({ label: 'Derive horizon (days)' }),
});
export type Config = z.infer<typeof config>;

export default defineManifest({
  id: 'calendar',
  name: 'Calendar',
  description: 'Shared calendars with recurring events, reminders, subscriptions and CalDAV access.',
  version: '0.1.0',
  icon: 'note',
  scope: 'shared',
  multiInstance: true,
  tile: { default: { w: 4, h: 4 }, min: { w: 2, h: 2 }, max: { w: 12, h: 8 } },
  settings,
  config,
  levels: ['view', 'edit'],
  jobs: [
    { name: 'reminders', intervalSec: 30, mode: 'always', per: 'module' },
    { name: 'derive', intervalSec: 300, mode: 'always', per: 'module' },
    { name: 'subscriptions', intervalSec: 3600, mode: 'always', per: 'module' },
  ],
  publishes: [
    'calendar.event.changed',
    'calendar.event.upcoming',
    'calendar.event.started',
    'calendar.day.summary',
    'todo.create.request',
    'todo.remove.request',
    'wled.apply.request',
    'pin.request',
    'countdown.request',
  ],
  subscribes: ['todo.changed'],
  outbound: [{ kind: 'publicUrl' }],
  rootMounts: [
    { prefix: '/dav', auth: 'appPassword' },
    { prefix: '/.well-known/caldav', auth: 'appPassword' },
  ],
});
