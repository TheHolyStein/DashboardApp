import { DashError, type ModuleDb, type UserId } from '@dash/contract';
import { newId } from '@dash/module-kit';

export type Access = 'none' | 'view' | 'edit' | 'owner';
export type ShareLevel = 'view' | 'edit';
export type Right = 'none' | 'view' | 'edit';

export interface CalendarRow {
  id: string;
  owner_id: string;
  name: string;
  color: string;
  kind: 'local' | 'subscription';
  source_url: string | null;
  sync_seq: number;
  created_at: string;
}

export const PERSONAL_NAME = 'Personal';
export const PERSONAL_COLOR = '#3b82f6';

/** The calendar row, or undefined. */
export function getCalendar(db: ModuleDb, calendarId: string): CalendarRow | undefined {
  return db.get<CalendarRow>('SELECT * FROM m_calendar_calendars WHERE id = ?', [calendarId]);
}

/** What `userId` may do on a calendar: its owner, a shared `view`/`edit` grant, or nothing. */
export function accessLevel(db: ModuleDb, calendarId: string, userId: UserId): Access {
  const cal = db.get<{ owner_id: string }>('SELECT owner_id FROM m_calendar_calendars WHERE id = ?', [calendarId]);
  if (!cal) return 'none';
  if (cal.owner_id === userId) return 'owner';
  const share = db.get<{ level: ShareLevel }>(
    'SELECT level FROM m_calendar_shares WHERE calendar_id = ? AND user_id = ?',
    [calendarId, userId],
  );
  return share?.level ?? 'none';
}

/** Effective right on a calendar's events: the lower of the module level and the calendar access. */
export function effectiveRight(moduleLevel: 'view' | 'edit', access: Access): Right {
  if (access === 'none') return 'none';
  const calendarRight: 'view' | 'edit' = access === 'view' ? 'view' : 'edit';
  return moduleLevel === 'view' || calendarRight === 'view' ? 'view' : 'edit';
}

/** Calendars the user owns or that are shared with them, oldest first. */
export function visibleCalendars(db: ModuleDb, userId: UserId): CalendarRow[] {
  return db.all<CalendarRow>(
    `SELECT c.* FROM m_calendar_calendars c
      WHERE c.owner_id = ?
         OR EXISTS (SELECT 1 FROM m_calendar_shares s WHERE s.calendar_id = c.id AND s.user_id = ?)
      ORDER BY c.created_at, c.id`,
    [userId, userId],
  );
}

function stamp(db: ModuleDb, now: Date | undefined): Date {
  // Callers pass host.now(); the SQLite clock is only the fallback for callers that cannot.
  if (now) return now;
  const row = db.get<{ t: string }>("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS t");
  return new Date(row?.t ?? 0);
}

export interface CreateOptions {
  now?: Date;
  kind?: 'local' | 'subscription';
  sourceUrl?: string | null;
}

export function createCalendar(
  db: ModuleDb,
  ownerId: UserId,
  input: { name: string; color: string },
  opts: CreateOptions = {},
): CalendarRow {
  const now = stamp(db, opts.now);
  const row: CalendarRow = {
    id: newId(now),
    owner_id: ownerId,
    name: input.name,
    color: input.color,
    kind: opts.kind ?? 'local',
    source_url: opts.sourceUrl ?? null,
    sync_seq: 0,
    created_at: now.toISOString(),
  };
  db.run(
    `INSERT INTO m_calendar_calendars (id, owner_id, name, color, kind, source_url, sync_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [row.id, row.owner_id, row.name, row.color, row.kind, row.source_url, row.created_at],
  );
  return row;
}

/**
 * Creates the user's "Personal" calendar on first access, exactly once. The primary key of
 * m_calendar_personal decides the race: the transaction inserts the marker first and creates the calendar only
 * if the marker was new. A Personal calendar the user later deletes does not come back.
 */
export function ensurePersonal(db: ModuleDb, userId: UserId, now?: Date): void {
  const at = stamp(db, now);
  db.transaction(() => {
    const marker = db.run('INSERT OR IGNORE INTO m_calendar_personal (user_id, calendar_id) VALUES (?, ?)', [userId, '']);
    if (marker.changes === 0) return;
    const cal = createCalendar(db, userId, { name: PERSONAL_NAME, color: PERSONAL_COLOR }, { now: at });
    db.run('UPDATE m_calendar_personal SET calendar_id = ? WHERE user_id = ?', [cal.id, userId]);
  });
}

/** Throws not_found for a stranger, forbidden for a user who sees the calendar but does not own it. */
export function assertOwner(db: ModuleDb, calendarId: string, userId: UserId): CalendarRow {
  return requireOwned(db, calendarId, userId);
}

function requireOwned(db: ModuleDb, calendarId: string, userId: UserId): CalendarRow {
  const cal = getCalendar(db, calendarId);
  if (!cal) throw new DashError('not_found', 'calendar not found');
  if (cal.owner_id !== userId) {
    // A stranger must not learn that the calendar exists; a user who can see it learns they may not change it.
    throw accessLevel(db, calendarId, userId) === 'none'
      ? new DashError('not_found', 'calendar not found')
      : new DashError('forbidden', 'only the owner may do that');
  }
  return cal;
}

/** Sets (or with 'none' removes) a user's grant on a calendar. Owner only. */
export function share(
  db: ModuleDb,
  calendarId: string,
  ownerId: UserId,
  targetUserId: UserId,
  level: ShareLevel | 'none',
): void {
  const cal = requireOwned(db, calendarId, ownerId);
  if (targetUserId === ownerId) throw new DashError('invalid', 'the owner already has full access');
  if (level === 'none') {
    db.run('DELETE FROM m_calendar_shares WHERE calendar_id = ? AND user_id = ?', [calendarId, targetUserId]);
    return;
  }
  if (cal.kind === 'subscription' && level === 'edit') {
    throw new DashError('invalid', 'a subscription calendar is read-only');
  }
  db.run(
    `INSERT INTO m_calendar_shares (calendar_id, user_id, level) VALUES (?, ?, ?)
     ON CONFLICT (calendar_id, user_id) DO UPDATE SET level = excluded.level`,
    [calendarId, targetUserId, level],
  );
}

export function sharesOf(db: ModuleDb, calendarId: string): Array<{ userId: string; level: ShareLevel }> {
  return db.all<{ userId: string; level: ShareLevel }>(
    'SELECT user_id AS userId, level FROM m_calendar_shares WHERE calendar_id = ? ORDER BY user_id',
    [calendarId],
  );
}

export function updateCalendar(
  db: ModuleDb,
  calendarId: string,
  ownerId: UserId,
  patch: { name?: string | undefined; color?: string | undefined },
): CalendarRow {
  const cal = requireOwned(db, calendarId, ownerId);
  const next = { name: patch.name ?? cal.name, color: patch.color ?? cal.color };
  db.run('UPDATE m_calendar_calendars SET name = ?, color = ? WHERE id = ?', [next.name, next.color, calendarId]);
  return { ...cal, ...next };
}

/** Deletes a calendar with its shares, events and change log. Owner only. */
export function deleteCalendar(db: ModuleDb, calendarId: string, ownerId: UserId): void {
  requireOwned(db, calendarId, ownerId);
  db.transaction(() => {
    db.run('DELETE FROM m_calendar_events WHERE calendar_id = ?', [calendarId]);
    db.run('DELETE FROM m_calendar_changes WHERE calendar_id = ?', [calendarId]);
    db.run('DELETE FROM m_calendar_shares WHERE calendar_id = ?', [calendarId]);
    db.run('DELETE FROM m_calendar_calendars WHERE id = ?', [calendarId]);
  });
}
