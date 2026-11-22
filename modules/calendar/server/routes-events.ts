import ICAL from 'ical.js';
import type { z } from 'zod';
import { DashError, type HostServices, type ModuleDb, type ModuleRouter, type UserId } from '@dash/contract';
import { newId } from '@dash/module-kit';
import { accessLevel, effectiveRight, getCalendar } from './calendars.js';
import {
  CreateBody,
  DeleteFields,
  EventInputSchema,
  EventsQuery,
  UpdateBody,
  occurrencesFor,
  type Scope,
  type UserLite,
} from './dto.js';
import { deleteEvent, eventRows, upsertEvent, type StoredEvent } from './events-repo.js';
import {
  firstKey,
  readResource,
  toVEvent,
  truncatedBefore,
  withExdate,
  withOverride,
  withOverridesOf,
  type EventInput,
} from './ical.js';

export type ChangeKind = 'created' | 'updated' | 'deleted';
export interface EventChange {
  uid: string;
  calendarId: string;
  kind: ChangeKind;
}

/** Called after every committed write: publishes `calendar.event.changed`, re-derives, refreshes snapshots. */
export type AfterWrite = (host: HostServices, changes: EventChange[]) => Promise<void>;

export function newUid(now: Date): string {
  return `${newId(now)}@home-dashboard`;
}

/** Throws unless the user may write events of the calendar: not_found for strangers, forbidden for read-only. */
export function requireWritable(db: ModuleDb, calendarId: string, userId: UserId, level: 'view' | 'edit'): void {
  const access = accessLevel(db, calendarId, userId);
  const cal = getCalendar(db, calendarId);
  if (!cal || access === 'none') throw new DashError('not_found', 'calendar not found');
  if (cal.kind !== 'local') throw new DashError('forbidden', 'a subscription calendar is read-only');
  if (effectiveRight(level, access) !== 'edit') throw new DashError('forbidden', 'you may only read this calendar');
}

/** The rows of an event the user may see (private events of others count as missing). */
function visibleRows(db: ModuleDb, calendarId: string, uid: string, userId: UserId): StoredEvent[] {
  const rows = eventRows(db, calendarId, uid);
  const first = rows[0];
  if (!first) throw new DashError('not_found', 'event not found');
  if (first.creator_id !== userId && rows.some((r) => r.is_private === 1)) throw new DashError('not_found', 'event not found');
  return rows;
}

function conflict(rows: StoredEvent[], calendarId: string): DashError {
  const first = rows[0]!;
  let event: unknown;
  try {
    const res = readResource(first.ics);
    const master = res.events.find((e) => e.parsed.recurrenceId === '') ?? res.events[0]!;
    event = { ...master.parsed, calendarId, etag: first.etag };
  } catch {
    event = { uid: first.uid, calendarId, etag: first.etag };
  }
  return new DashError('conflict', 'the event changed since it was read', { etag: first.etag, event });
}

function inputOf(body: z.infer<typeof EventInputSchema>): EventInput {
  const input: EventInput = { title: body.title, start: body.start, end: body.end, allDay: body.allDay, timeZone: body.timeZone };
  if (body.description !== undefined) input.description = body.description;
  if (body.location !== undefined) input.location = body.location;
  if (body.rrule !== undefined) input.rrule = body.rrule;
  if (body.exdates !== undefined) input.exdates = body.exdates;
  return input;
}

function normRule(rule: string | null | undefined): string | null {
  if (!rule) return null;
  try {
    return ICAL.Recur.fromString(rule.replace(/^RRULE:/i, '')).toString();
  } catch {
    return rule;
  }
}

function scopeKey(scope: Scope, occurrenceStart: string | undefined): string {
  if (scope === 'all') return '';
  if (!occurrenceStart) throw new DashError('invalid', `scope "${scope}" needs occurrenceStart`);
  return occurrenceStart;
}

export interface WriteResult {
  uid: string;
  etag: string;
  /** For `scope: 'future'`: the uid of the new series that starts at the occurrence. */
  splitUid?: string;
}

/** PUT: replaces the whole series, one instance, or the instance and all later ones. Synchronous (one transaction). */
export function updateEvent(
  db: ModuleDb,
  uid: string,
  body: z.infer<typeof UpdateBody>,
  ctx: { userId: UserId; now: Date },
): { result: WriteResult; changes: EventChange[] } {
  const { calendarId } = body;
  const input = inputOf(body);
  return db.transaction(() => {
    const rows = visibleRows(db, calendarId, uid, ctx.userId);
    const first = rows[0]!;
    if (body.etag.replace(/^W\//, '') !== first.etag) throw conflict(rows, calendarId);
    const current = first.ics;
    const master = readResource(current).events.find((e) => e.parsed.recurrenceId === '');
    const recurring = master?.recurring ?? false;
    let scope: Scope = recurring ? body.scope : 'all';
    const key = recurring ? scopeKey(scope, body.occurrenceStart) : '';
    if (scope === 'future' && master && key === firstKey(master)) scope = 'all';
    const opts = { ifMatch: first.etag, creatorId: first.creator_id, now: ctx.now };
    const changes: EventChange[] = [{ uid, calendarId, kind: 'updated' }];

    if (scope === 'this') {
      const res = upsertEvent(db, calendarId, withOverride(current, key, input, ctx.now), opts);
      return { result: { uid, etag: res.etag }, changes };
    }
    if (scope === 'future') {
      const res = upsertEvent(db, calendarId, truncatedBefore(current, key), opts);
      const splitUid = newUid(ctx.now);
      upsertEvent(db, calendarId, toVEvent(input, splitUid, ctx.now), { creatorId: first.creator_id, now: ctx.now });
      changes.push({ uid: splitUid, calendarId, kind: 'created' });
      return { result: { uid, etag: res.etag, splitUid }, changes };
    }
    let next = toVEvent(input, uid, ctx.now);
    // Overrides stay valid while the series keeps its start, zone and rule (their RECURRENCE-IDs still match).
    const sameTiming =
      master !== undefined &&
      recurring &&
      master.parsed.start === input.start &&
      master.parsed.allDay === input.allDay &&
      master.parsed.timeZone === (input.allDay ? 'floating' : input.timeZone) &&
      normRule(master.parsed.rrule) === normRule(input.rrule);
    if (sameTiming) next = withOverridesOf(current, next);
    const res = upsertEvent(db, calendarId, next, opts);
    return { result: { uid, etag: res.etag }, changes };
  });
}

/** DELETE: the whole series, one instance (EXDATE), or the instance and all later ones (UNTIL). */
export function removeEvent(
  db: ModuleDb,
  uid: string,
  body: { calendarId: string; etag: string; scope: Scope; occurrenceStart?: string | undefined },
  ctx: { userId: UserId; now: Date },
): EventChange[] {
  const { calendarId } = body;
  return db.transaction(() => {
    const rows = visibleRows(db, calendarId, uid, ctx.userId);
    const first = rows[0]!;
    if (body.etag.replace(/^W\//, '') !== first.etag) throw conflict(rows, calendarId);
    const master = readResource(first.ics).events.find((e) => e.parsed.recurrenceId === '');
    const recurring = master?.recurring ?? false;
    let scope: Scope = recurring ? body.scope : 'all';
    const key = recurring ? scopeKey(scope, body.occurrenceStart) : '';
    if (scope === 'future' && master && key === firstKey(master)) scope = 'all';
    const opts = { ifMatch: first.etag, creatorId: first.creator_id, now: ctx.now };
    if (scope === 'all') {
      deleteEvent(db, calendarId, uid, { ifMatch: first.etag, now: ctx.now });
      return [{ uid, calendarId, kind: 'deleted' }];
    }
    const next = scope === 'this' ? withExdate(first.ics, key) : truncatedBefore(first.ics, key);
    upsertEvent(db, calendarId, next, opts);
    return [{ uid, calendarId, kind: 'updated' }];
  });
}

async function usersOf(host: HostServices): Promise<UserLite[]> {
  return (await host.users()).map((u) => ({ id: u.id, handle: u.handle }));
}

export function registerEventRoutes(r: ModuleRouter, host: HostServices, afterWrite: AfterWrite): void {
  const db = host.store.db;

  r.get('/events', { level: 'view', query: EventsQuery }, async (req) => {
    const users = await usersOf(host);
    const ids = (req.query.calendarIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const seen = occurrencesFor(db, {
      userId: req.user.id,
      level: req.level,
      from: new Date(req.query.from),
      to: new Date(req.query.to),
      calendarIds: ids,
      users,
    });
    return { events: seen.map((s) => s.dto) };
  });

  r.post('/events', { level: 'edit', body: CreateBody }, async (req) => {
    const now = host.now();
    const { calendarId, ...rest } = req.body;
    requireWritable(db, calendarId, req.user.id, req.level);
    const uid = newUid(now);
    const res = upsertEvent(db, calendarId, toVEvent(inputOf(rest), uid, now), { creatorId: req.user.id, now });
    await afterWrite(host, [{ uid, calendarId, kind: 'created' }]);
    return { uid, etag: res.etag };
  });

  r.put('/events/:uid', { level: 'edit', body: UpdateBody }, async (req) => {
    const uid = req.params['uid'] ?? '';
    requireWritable(db, req.body.calendarId, req.user.id, req.level);
    const { result, changes } = updateEvent(db, uid, req.body, { userId: req.user.id, now: host.now() });
    await afterWrite(host, changes);
    return result;
  });

  // The client's ModuleApi.delete can send neither a body nor a query: it deletes through this POST instead.
  r.post('/events/:uid/delete', { level: 'edit', body: DeleteFields }, async (req) => {
    const uid = req.params['uid'] ?? '';
    requireWritable(db, req.body.calendarId, req.user.id, req.level);
    const changes = removeEvent(db, uid, req.body, { userId: req.user.id, now: host.now() });
    await afterWrite(host, changes);
    return undefined;
  });

  // For other HTTP clients: the fields in the body or the query.
  r.delete('/events/:uid', { level: 'edit', body: DeleteFields.optional(), query: DeleteFields.partial() }, async (req) => {
    const uid = req.params['uid'] ?? '';
    const parsed = DeleteFields.safeParse(req.body ?? req.query);
    if (!parsed.success) throw new DashError('invalid', 'calendarId and etag are required', parsed.error.issues);
    requireWritable(db, parsed.data.calendarId, req.user.id, req.level);
    const changes = removeEvent(db, uid, parsed.data, { userId: req.user.id, now: host.now() });
    await afterWrite(host, changes);
    return undefined;
  });
}
