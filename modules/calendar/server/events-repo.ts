import { createHash } from 'node:crypto';
import { DashError, type ModuleDb, type UserId } from '@dash/contract';
import { readResource, type ResourceEvent } from './ical.js';
import { seriesEnd } from './recurrence.js';

/** A row of m_calendar_events. */
export interface StoredEvent {
  uid: string;
  calendar_id: string;
  recurrence_id: string;
  ics: string;
  etag: string;
  summary: string;
  description: string;
  location: string;
  dtstart_utc: string;
  dtend_utc: string;
  all_day: number;
  tzid: string;
  has_rrule: number;
  until_utc: string | null;
  tags: string;
  mentions: string;
  is_private: number;
  creator_id: string;
  modified_at: string;
}

/** `"` + the first 16 hex digits of SHA-256(ics) + `"`. */
export function etagOf(ics: string): string {
  return `"${createHash('sha256').update(ics, 'utf8').digest('hex').slice(0, 16)}"`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function checkIfMatch(ifMatch: string | null | undefined, current: string | undefined): void {
  if (ifMatch === null || ifMatch === undefined) return;
  const wanted = ifMatch.replace(/^W\//, '');
  const ok = current !== undefined && (wanted === '*' || wanted === current);
  if (!ok) throw new DashError('conflict', 'the event changed since it was read', { etag: current ?? null });
}

/** Appends to the calendar's change log and bumps its sync token; call inside the writing transaction. */
function logChange(db: ModuleDb, calendarId: string, uid: string, deleted: boolean, at: string): void {
  db.run('UPDATE m_calendar_calendars SET sync_seq = sync_seq + 1 WHERE id = ?', [calendarId]);
  const seq = db.get<{ sync_seq: number }>('SELECT sync_seq FROM m_calendar_calendars WHERE id = ?', [calendarId])?.sync_seq;
  if (seq === undefined) throw new DashError('not_found', 'calendar not found');
  db.run('INSERT INTO m_calendar_changes (calendar_id, seq, uid, deleted, at) VALUES (?, ?, ?, ?, ?)', [
    calendarId,
    seq,
    uid,
    deleted ? 1 : 0,
    at,
  ]);
}

function untilOf(ev: ResourceEvent): string | null {
  const end = ev.recurring ? seriesEnd(ev) : ev.endMs;
  return end === null ? null : iso(end);
}

/** The rows of one resource (master first), or [] when it does not exist. */
export function eventRows(db: ModuleDb, calendarId: string, uid: string): StoredEvent[] {
  return db.all<StoredEvent>(
    "SELECT * FROM m_calendar_events WHERE calendar_id = ? AND uid = ? ORDER BY recurrence_id = '' DESC, recurrence_id",
    [calendarId, uid],
  );
}

/**
 * Stores (creates or replaces) one resource. `ics` is kept exactly as received; every other column is derived from it.
 * `ifMatch` (an etag, or `*` for "must exist") makes the write conditional (DashError 'conflict' otherwise). The
 * rows, the change-log entry and the calendar's sync token move together in one transaction.
 * Throws DashError('invalid') for data that is not exactly one event resource, before anything is written.
 */
export function upsertEvent(
  db: ModuleDb,
  calendarId: string,
  ics: string,
  opts: { ifMatch?: string | null; creatorId: UserId; now: Date },
): { uid: string; etag: string; created: boolean } {
  const resource = readResource(ics);
  const etag = etagOf(ics);
  const at = opts.now.toISOString();

  return db.transaction(() => {
    if (!db.get('SELECT 1 AS x FROM m_calendar_calendars WHERE id = ?', [calendarId])) {
      throw new DashError('not_found', 'calendar not found');
    }
    const existing = db.get<{ etag: string; creator_id: string }>(
      'SELECT etag, creator_id FROM m_calendar_events WHERE calendar_id = ? AND uid = ? LIMIT 1',
      [calendarId, resource.uid],
    );
    checkIfMatch(opts.ifMatch, existing?.etag);

    db.run('DELETE FROM m_calendar_events WHERE calendar_id = ? AND uid = ?', [calendarId, resource.uid]);
    for (const ev of resource.events) {
      const p = ev.parsed;
      db.run(
        `INSERT INTO m_calendar_events
           (uid, calendar_id, recurrence_id, ics, etag, summary, description, location, dtstart_utc, dtend_utc,
            all_day, tzid, has_rrule, until_utc, tags, mentions, is_private, creator_id, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?)`,
        [
          resource.uid,
          calendarId,
          p.recurrenceId,
          ics,
          etag,
          p.title,
          p.description,
          p.location,
          iso(ev.startMs),
          iso(ev.endMs),
          p.allDay ? 1 : 0,
          p.timeZone,
          ev.recurring ? 1 : 0,
          untilOf(ev),
          ev.isPrivate ? 1 : 0,
          existing?.creator_id ?? opts.creatorId,
          at,
        ],
      );
    }
    logChange(db, calendarId, resource.uid, false, at);
    return { uid: resource.uid, etag, created: existing === undefined };
  });
}

/** Removes a resource. DashError 'not_found' when it does not exist, 'conflict' when `ifMatch` does not match. */
export function deleteEvent(
  db: ModuleDb,
  calendarId: string,
  uid: string,
  opts: { ifMatch?: string | null; now: Date },
): void {
  db.transaction(() => {
    const existing = db.get<{ etag: string }>(
      'SELECT etag FROM m_calendar_events WHERE calendar_id = ? AND uid = ? LIMIT 1',
      [calendarId, uid],
    );
    if (!existing) throw new DashError('not_found', 'event not found');
    checkIfMatch(opts.ifMatch, existing.etag);
    db.run('DELETE FROM m_calendar_events WHERE calendar_id = ? AND uid = ?', [calendarId, uid]);
    logChange(db, calendarId, uid, true, opts.now.toISOString());
  });
}
