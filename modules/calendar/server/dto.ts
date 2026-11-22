import { z } from 'zod';
import type { ModuleDb, UserId } from '@dash/contract';
import { accessLevel, effectiveRight, visibleCalendars, type CalendarRow } from './calendars.js';
import { displayTitle, eventMarkers } from './commands/parse.js';
import type { StoredEvent } from './events-repo.js';
import { expand, type Occurrence } from './recurrence.js';

export const OccurrenceDto = z.object({
  uid: z.string(),
  calendarId: z.string(),
  etag: z.string(),
  /** null for a single event; the instance key (RECURRENCE-ID form) for an instance of a series. */
  recurrenceId: z.string().nullable(),
  title: z.string(),
  displayTitle: z.string(),
  description: z.string(),
  location: z.string(),
  /** Wall clock in `timeZone` (all-day: dates, `end` exclusive). */
  start: z.string(),
  end: z.string(),
  /** ISO instants of `start` / `end` (all-day: midnight UTC of the dates). */
  startUtc: z.string(),
  endUtc: z.string(),
  allDay: z.boolean(),
  timeZone: z.string(),
  rrule: z.string().nullable(),
  tags: z.array(z.string()),
  mentions: z.array(z.string()),
  color: z.string(),
  editable: z.boolean(),
});
export type OccurrenceDto = z.infer<typeof OccurrenceDto>;

const WallOrDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/, 'YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss');

export const EventInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  location: z.string().max(500).optional(),
  start: WallOrDate,
  end: WallOrDate,
  allDay: z.boolean(),
  timeZone: z.string().min(1).max(64),
  rrule: z.string().max(500).nullable().optional(),
  exdates: z.array(WallOrDate).max(500).optional(),
});

export const Scope = z.enum(['all', 'this', 'future']);
export type Scope = z.infer<typeof Scope>;

const Instant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'ISO date-time');

export const EventsQuery = z.object({
  from: Instant,
  to: Instant,
  /** Comma-separated; absent or empty = every visible calendar. */
  calendarIds: z.string().optional(),
});

export const CreateBody = EventInputSchema.extend({ calendarId: z.string().min(1) });
export const UpdateBody = EventInputSchema.extend({
  calendarId: z.string().min(1),
  etag: z.string().min(1),
  scope: Scope.default('all'),
  occurrenceStart: z.string().optional(),
});
export const DeleteFields = z.object({
  calendarId: z.string().min(1),
  etag: z.string().min(1),
  scope: Scope.default('all'),
  occurrenceStart: z.string().optional(),
});

export interface UserLite {
  id: UserId;
  handle: string;
}

/** Whether `userId` may see an occurrence: private events (`CLASS:PRIVATE` or `#private`) only for their creator. */
export function isHiddenFrom(o: Occurrence, creatorId: string, userId: UserId): boolean {
  if (creatorId === userId) return false;
  return o.isPrivate || eventMarkers(o.title, o.description).isPrivate;
}

export function toOccurrenceDto(
  o: Occurrence,
  ctx: { etag: string; color: string; editable: boolean; handles: Iterable<string> },
): OccurrenceDto {
  const markers = eventMarkers(o.title, o.description, ctx.handles);
  return {
    uid: o.uid,
    calendarId: o.calendarId,
    etag: ctx.etag,
    recurrenceId: o.recurrenceId === '' ? null : o.recurrenceId,
    title: o.title,
    displayTitle: displayTitle(o.title),
    description: o.description,
    location: o.location,
    start: o.start,
    end: o.end,
    startUtc: o.startUtc,
    endUtc: o.endUtc,
    allDay: o.allDay,
    timeZone: o.timeZone,
    rrule: o.rrule,
    tags: markers.tags,
    mentions: markers.mentions,
    color: ctx.color,
    editable: ctx.editable,
  };
}

/** Stored rows of the given calendars that may have an occurrence overlapping `[from, to)`. */
export function rowsInRange(db: ModuleDb, calendarIds: string[], from: Date, to: Date): StoredEvent[] {
  if (calendarIds.length === 0) return [];
  const marks = calendarIds.map(() => '?').join(', ');
  // All-day rows sit at midnight UTC; a day of slack on both sides keeps them for viewers in any zone.
  const lo = new Date(from.getTime() - 86_400_000).toISOString();
  const hi = new Date(to.getTime() + 86_400_000).toISOString();
  return db.all<StoredEvent>(
    `SELECT * FROM m_calendar_events
      WHERE calendar_id IN (${marks}) AND dtstart_utc < ? AND (until_utc IS NULL OR until_utc > ?)
      ORDER BY calendar_id, uid, recurrence_id`,
    [...calendarIds, hi, lo],
  );
}

/** A calendar's occurrences as seen by one user, with the private ones of other users removed. */
export interface Seen {
  occurrence: Occurrence;
  dto: OccurrenceDto;
  creatorId: string;
}

/**
 * Occurrences in `[from, to)` that `userId` may see, from the calendars visible to them (optionally narrowed to
 * `calendarIds`). `level` is the caller's module level; it caps `editable`.
 */
export function occurrencesFor(
  db: ModuleDb,
  opts: { userId: UserId; level: 'view' | 'edit'; from: Date; to: Date; calendarIds?: string[]; users: UserLite[] },
): Seen[] {
  let calendars: CalendarRow[] = visibleCalendars(db, opts.userId);
  if (opts.calendarIds && opts.calendarIds.length > 0) {
    const wanted = new Set(opts.calendarIds);
    calendars = calendars.filter((c) => wanted.has(c.id));
  }
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const rows = rowsInRange(db, [...byId.keys()], opts.from, opts.to);
  const meta = new Map<string, { etag: string; creatorId: string }>();
  for (const r of rows) meta.set(`${r.calendar_id}\u0000${r.uid}`, { etag: r.etag, creatorId: r.creator_id });
  const handles = opts.users.map((u) => u.handle);
  const editableOf = new Map(
    calendars.map((c) => [
      c.id,
      c.kind === 'local' && effectiveRight(opts.level, accessLevel(db, c.id, opts.userId)) === 'edit',
    ]),
  );

  const out: Seen[] = [];
  for (const o of expand(rows, opts.from, opts.to)) {
    const m = meta.get(`${o.calendarId}\u0000${o.uid}`);
    const cal = byId.get(o.calendarId);
    if (!m || !cal) continue;
    if (isHiddenFrom(o, m.creatorId, opts.userId)) continue;
    out.push({
      occurrence: o,
      creatorId: m.creatorId,
      dto: toOccurrenceDto(o, { etag: m.etag, color: cal.color, editable: editableOf.get(cal.id) ?? false, handles }),
    });
  }
  return out;
}
