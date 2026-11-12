import { z } from 'zod';

// Declared before `events`: the catalog references them at module evaluation time.
export const WeatherCondition = z.enum(['clear','cloudy','fog','drizzle','rain','snow','storm']);
export const TodoList = z.enum(['week','month','deadline','shopping','chores']);

// The event catalog. Adding an event = adding a key here.
export const events = {
  'time.sun':                 z.object({ sunrise: z.string(), sunset: z.string(), isDay: z.boolean() }),
  'weather.updated':          z.object({ condition: WeatherCondition, tempC: z.number(),
                                nextPrecip: z.object({ at: z.string(), mm: z.number() }).nullable(),
                                pollenMax: z.number().min(0).max(5).nullable(), aqi: z.number().nullable() }),
  'moon.updated':             z.object({ phase: z.number().min(0).max(1), illumination: z.number() }),
  'calendar.event.changed':   z.object({ uid: z.string(), calendarId: z.string(), kind: z.enum(['created','updated','deleted']) }),
  'calendar.event.upcoming':  z.object({ uid: z.string(), title: z.string(), start: z.string(), minutesUntil: z.number(), userIds: z.array(z.string()) }),
  'calendar.event.started':   z.object({ uid: z.string(), title: z.string(), start: z.string(), userIds: z.array(z.string()), tags: z.array(z.string()) }),
  'calendar.day.summary':     z.object({ userId: z.string(), date: z.string(), events: z.array(z.object({ uid: z.string(), title: z.string(),
                                start: z.string(), end: z.string(), allDay: z.boolean(), tags: z.array(z.string()) })) }),
  'todo.day.summary':         z.object({ userId: z.string(), date: z.string(), overdue: z.number(),
                                due: z.array(z.object({ id: z.string(), title: z.string(), list: TodoList })) }),
  'notification.created':     z.object({ id: z.string(), userId: z.string(), moduleId: z.string(), level: z.enum(['info','warn','critical']),
                                title: z.string(), createdAt: z.string() }),   // published by core only
  'todo.create.request':      z.object({ sourceKey: z.string(), list: TodoList, title: z.string(), due: z.string().nullable(),
                                assigneeId: z.string().nullable(), icon: z.string().nullable(), url: z.string().nullable() }),
  'todo.remove.request':      z.object({ sourceKey: z.string() }),
  'todo.changed':             z.object({ itemId: z.string(), kind: z.enum(['created','updated','done','deleted']) }),
  'wled.apply.request':       z.object({ target: z.string(), preset: z.string().optional(), on: z.boolean().optional(),
                                color: z.string().optional(), effect: z.string().optional(), flash: z.boolean().optional() }),
  'net.connectivity.changed': z.object({ online: z.boolean(), since: z.string() }),
  'net.device.unknown':       z.object({ mac: z.string(), ip: z.string(), vendor: z.string().nullable() }),
  'device.offline':           z.object({ kind: z.string(), id: z.string(), name: z.string() }),
  'nas.health.changed':       z.object({ status: z.enum(['ok','degraded','failed']), detail: z.string() }),
  'air.threshold':            z.object({ sensorId: z.string(), metric: z.string(), value: z.number(), level: z.enum(['ok','warn','crit']) }),
  'stock.threshold':          z.object({ symbol: z.string(), price: z.number(), direction: z.enum(['above','below']) }),
  'timer.finished':           z.object({ id: z.string(), label: z.string() }),
  'focus.phase':              z.object({ phase: z.enum(['work','break','idle']) }),
  'item.readLater':           z.object({ title: z.string(), url: z.string(), source: z.string() }),
  'pin.request':              z.object({ sourceKey: z.string(), title: z.string(), date: z.string(), userIds: z.array(z.string()) }),
  'countdown.request':        z.object({ sourceKey: z.string(), title: z.string(), at: z.string() }),
} as const;
export type EventName = keyof typeof events;
export type EventPayload<E extends EventName> = z.infer<(typeof events)[E]>;
