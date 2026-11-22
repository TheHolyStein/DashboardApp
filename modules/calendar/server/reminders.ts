import type { EventName, HostServices, ModuleInstance, UserId } from '@dash/contract';
import { createSnapshotPusher, type SnapshotPusher } from '@dash/module-kit';
import { settings as settingsSchema, type Settings } from '../manifest.js';
import { visibleCalendars } from './calendars.js';
import { occurrencesFor, type OccurrenceDto, type Seen, type UserLite } from './dto.js';
import { ianaOffset, isIanaZone } from './zones.js';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Reminders more than this late (the server was down) are dropped instead of fired. */
export const MISSED_AFTER_MS = 6 * HOUR_MS;
export const UPCOMING_WINDOW_MIN = 120;
export const UPCOMING_THRESHOLDS = [60, 30, 15, 5, 0] as const;

export type OccurrenceLite = Pick<
  OccurrenceDto,
  'uid' | 'calendarId' | 'recurrenceId' | 'displayTitle' | 'start' | 'end' | 'startUtc' | 'endUtc' | 'allDay' | 'timeZone' | 'color' | 'tags' | 'mentions'
>;

export interface Snapshot {
  /** The owner's local date the snapshot was built for. */
  date: string;
  today: OccurrenceLite[];
  next: OccurrenceLite[];
  calendars: Array<{ id: string; name: string; color: string }>;
}

type User = Awaited<ReturnType<HostServices['users']>>[number];

const zoneOf = (u: { timeZone: string } | undefined): string => (u && isIanaZone(u.timeZone) ? u.timeZone : 'UTC');

/** `YYYY-MM-DD` of an instant in a zone. */
export function localDate(ms: number, tz: string): string {
  return new Date(ms + ianaOffset(tz, ms) * 1000).toISOString().slice(0, 10);
}

/** The UTC instant at which a local date begins in a zone. */
export function localMidnight(date: string, tz: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  let utc = wall - ianaOffset(tz, wall) * 1000;
  utc = wall - ianaOffset(tz, utc) * 1000;
  return utc;
}

const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Whether an occurrence touches a local date (all-day events by their dates, timed ones by their instants). */
function onDate(o: OccurrenceDto, date: string, tz: string): boolean {
  if (o.allDay) return o.start <= date && date < o.end;
  const lo = localMidnight(date, tz);
  const hi = localMidnight(addDays(date, 1), tz);
  const s = Date.parse(o.startUtc);
  const e = Math.max(Date.parse(o.endUtc), s + 1);
  return s < hi && e > lo;
}

const isPrivateFor = (s: Seen): boolean => s.occurrence.isPrivate || s.dto.tags.includes('private');

function lite(o: OccurrenceDto): OccurrenceLite {
  return {
    uid: o.uid,
    calendarId: o.calendarId,
    recurrenceId: o.recurrenceId,
    displayTitle: o.displayTitle,
    start: o.start,
    end: o.end,
    startUtc: o.startUtc,
    endUtc: o.endUtc,
    allDay: o.allDay,
    timeZone: o.timeZone,
    color: o.color,
    tags: o.tags,
    mentions: o.mentions,
  };
}

const sortLite = (a: OccurrenceDto, b: OccurrenceDto): number =>
  Number(b.allDay) - Number(a.allDay) || (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : a.uid < b.uid ? -1 : 1);

/**
 * The tile snapshot of one instance, from its owner's point of view. Private events are left out entirely: the page
 * may be shared, and the snapshot goes to everyone who can see it (each user sees their own in the detail view).
 */
export function buildSnapshot(host: HostServices, inst: ModuleInstance<unknown>, users: User[], now: Date): Snapshot {
  const parsed = settingsSchema.safeParse(inst.settings ?? {});
  const s: Settings = parsed.success ? parsed.data : settingsSchema.parse({});
  const owner = users.find((u) => u.id === inst.ownerId);
  const tz = zoneOf(owner);
  const today = localDate(now.getTime(), tz);
  const db = host.store.db;
  const seen = occurrencesFor(db, {
    userId: inst.ownerId,
    level: 'view',
    from: new Date(localMidnight(today, tz)),
    to: new Date(localMidnight(addDays(today, s.daysAhead + 1), tz)),
    calendarIds: s.calendarIds,
    users: users.map((u): UserLite => ({ id: u.id, handle: u.handle })),
  }).filter((x) => !isPrivateFor(x));
  const dtos = seen.map((x) => x.dto).sort(sortLite);
  const nowMs = now.getTime();
  const todays = dtos.filter((o) => onDate(o, today, tz) && (o.allDay || Date.parse(o.endUtc) > nowMs));
  const todayKeys = new Set(todays.map((o) => `${o.uid}|${o.startUtc}`));
  const later = dtos.filter((o) => !todayKeys.has(`${o.uid}|${o.startUtc}`) && !onDate(o, today, tz)).slice(0, 8);
  const wanted = new Set(s.calendarIds);
  const calendars = visibleCalendars(db, inst.ownerId)
    .filter((c) => wanted.size === 0 || wanted.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, color: c.color }));
  return { date: today, today: todays.map(lite), next: later.map(lite), calendars };
}

interface ReminderRow {
  source_key: string;
  calendar_id: string;
  uid: string;
  occurrence: string;
  fire_at: string;
  user_ids: string;
  title: string;
  action_json: string | null;
}

/** Fires due reminders once; ones missed by more than 6 h are dropped silently. */
export async function fireReminders(host: HostServices, now: Date): Promise<void> {
  const db = host.store.db;
  const nowIso = now.toISOString();
  const due = db.transaction(() => {
    const rows = db.all<ReminderRow>('SELECT * FROM m_calendar_reminders WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at', [nowIso]);
    for (const r of rows) db.run('UPDATE m_calendar_reminders SET fired = 1 WHERE source_key = ?', [r.source_key]);
    return rows;
  });
  if (due.length === 0) return;
  const instances = await host.instances();
  for (const r of due) {
    if (now.getTime() - Date.parse(r.fire_at) > MISSED_AFTER_MS) continue;
    if (r.action_json) {
      const action = JSON.parse(r.action_json) as { name: EventName; payload: unknown };
      host.bus.publish(action.name as never, action.payload as never);
      continue;
    }
    const userIds = JSON.parse(r.user_ids) as UserId[];
    if (userIds.length === 0) continue;
    const inst = instances.find((i) => userIds.includes(i.ownerId)) ?? instances[0];
    const minutes = Math.max(0, Math.round((Date.parse(r.occurrence) - now.getTime()) / MIN_MS));
    host.notify({
      level: 'info',
      title: r.title || 'Event',
      body: minutes > 0 ? `Starts in ${minutes} min` : 'Starts now',
      titleKey: 'calendar.reminder.title',
      bodyKey: minutes > 0 ? 'calendar.reminder.in' : 'calendar.reminder.now',
      vars: { title: r.title, minutes },
      dedupeKey: r.source_key,
      userIds,
      ...(inst ? { url: `/?d=${encodeURIComponent(inst.id)}&dp.event=${encodeURIComponent(r.uid)}` } : {}),
    });
  }
}

const STARTED_KEY = 'started';

/** Per-host state of the views (kept in the server's setup closure). */
export interface Views {
  pusher: SnapshotPusher;
  /** Last `calendar.day.summary` per user (JSON), published or not. */
  summaries: Map<UserId, string>;
  /** Per user: the next event's key and the lowest threshold already announced. */
  upcoming: Map<UserId, { key: string; threshold: number }>;
}

export function createViews(host: Pick<HostServices, 'push'>): Views {
  return { pusher: createSnapshotPusher(host), summaries: new Map(), upcoming: new Map() };
}

/** Day summaries (when changed: at startup, at local midnight, on any change) and tile snapshots. */
export async function publishViews(host: HostServices, views: Views, now: Date): Promise<void> {
  const users = await host.users();
  const lites = users.map((u): UserLite => ({ id: u.id, handle: u.handle }));
  for (const u of users) {
    const tz = zoneOf(u);
    const date = localDate(now.getTime(), tz);
    const seen = occurrencesFor(host.store.db, {
      userId: u.id,
      level: 'view',
      from: new Date(localMidnight(date, tz)),
      to: new Date(localMidnight(addDays(date, 1), tz)),
      users: lites,
    });
    const events = seen
      .map((x) => x.dto)
      .filter((o) => onDate(o, date, tz))
      .sort(sortLite)
      .map((o) => ({ uid: o.uid, title: o.displayTitle, start: o.startUtc, end: o.endUtc, allDay: o.allDay, tags: o.tags }));
    const payload = { userId: u.id, date, events };
    const json = JSON.stringify(payload);
    const prev = views.summaries.get(u.id);
    if (prev === json) continue;
    // An empty summary only clears a non-empty one (nothing to say otherwise, e.g. at startup).
    if (events.length === 0 && (prev === undefined || (JSON.parse(prev) as { events: unknown[] }).events.length === 0)) {
      views.summaries.set(u.id, json);
      continue;
    }
    host.bus.publish('calendar.day.summary', payload);
    views.summaries.set(u.id, json);
  }
  const instances = await host.instances();
  for (const inst of instances) views.pusher.push(inst.id, buildSnapshot(host, inst, users, now));
}

/** `calendar.event.upcoming` at each threshold and on change of the next event; `calendar.event.started` once. */
export async function announce(host: HostServices, views: Views, now: Date): Promise<void> {
  const users = await host.users();
  const lites = users.map((u): UserLite => ({ id: u.id, handle: u.handle }));
  const nowMs = now.getTime();
  const started = new Map<string, { uid: string; title: string; start: string; tags: string[]; userIds: UserId[] }>();

  for (const u of users) {
    const seen = occurrencesFor(host.store.db, {
      userId: u.id,
      level: 'view',
      from: new Date(nowMs - 10 * MIN_MS),
      to: new Date(nowMs + UPCOMING_WINDOW_MIN * MIN_MS),
      users: lites,
    }).filter((x) => !x.dto.allDay);

    for (const x of seen) {
      const s = Date.parse(x.dto.startUtc);
      if (s > nowMs || s <= nowMs - 10 * MIN_MS) continue;
      const key = `${x.dto.calendarId}|${x.dto.uid}|${x.dto.startUtc}`;
      const entry = started.get(key) ?? { uid: x.dto.uid, title: x.dto.displayTitle, start: x.dto.startUtc, tags: x.dto.tags, userIds: [] };
      entry.userIds.push(u.id);
      started.set(key, entry);
    }

    const next = seen.find((x) => Date.parse(x.dto.startUtc) >= nowMs - 30_000);
    if (!next) {
      views.upcoming.delete(u.id);
      continue;
    }
    const minutesUntil = Math.max(0, Math.ceil((Date.parse(next.dto.startUtc) - nowMs) / MIN_MS));
    const crossed = UPCOMING_THRESHOLDS.filter((t) => minutesUntil <= t);
    const threshold = crossed.length > 0 ? crossed[crossed.length - 1]! : Infinity;
    const key = `${next.dto.calendarId}|${next.dto.uid}|${next.dto.startUtc}|${next.dto.displayTitle}`;
    const prev = views.upcoming.get(u.id);
    if (prev && prev.key === key && prev.threshold <= threshold) continue;
    views.upcoming.set(u.id, { key, threshold });
    host.bus.publish('calendar.event.upcoming', {
      uid: next.dto.uid,
      title: next.dto.displayTitle,
      start: next.dto.startUtc,
      minutesUntil,
      userIds: [u.id],
    });
  }

  // Started: remembered in the store for a day so that a restart does not announce an occurrence twice.
  const done = new Map(Object.entries((await host.store.get<Record<string, number>>(STARTED_KEY)) ?? {}));
  let changed = false;
  for (const [key, at] of done) {
    if (at < nowMs - DAY_MS) {
      done.delete(key);
      changed = true;
    }
  }
  for (const [key, e] of started) {
    if (done.has(key)) continue;
    done.set(key, nowMs);
    changed = true;
    host.bus.publish('calendar.event.started', e);
  }
  if (changed) await host.store.set(STARTED_KEY, Object.fromEntries(done));
}
