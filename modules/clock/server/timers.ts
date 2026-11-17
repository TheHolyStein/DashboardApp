import { z } from 'zod';
import { DashError, type ModuleDb, type UserId } from '@dash/contract';
import { newId } from '@dash/module-kit';

export const MAX_LABEL = 40;
export const MAX_DURATION_SEC = 86_400;
export const MAX_LISTED = 20; // keeps the snapshot far below 20 KB
export const MAX_ACTIVE = 50; // running timers per owner
export const PURGE_AFTER_MS = 86_400_000; // fired rows are kept one day

export interface Timer {
  id: string;
  ownerId: UserId;
  label: string;
  endsAt: string; // ISO-8601 UTC
  durationSec: number;
  fired: boolean;
}

/** Shared by createTimer and the POST /timers route, so both reject the same inputs. */
export const timerInput = z.object({
  label: z.string().trim().max(MAX_LABEL),
  durationSec: z.number().int().min(1).max(MAX_DURATION_SEC),
});

interface Row {
  id: string;
  owner_id: string;
  label: string;
  ends_at: string;
  duration_sec: number;
  fired: number;
}

const COLUMNS = 'id, owner_id, label, ends_at, duration_sec, fired';

/** The one timer shape that goes over the wire (snapshot and routes); fixed key order keeps pushes comparable. */
export const toWire = (t: Timer) => ({ id: t.id, label: t.label, endsAt: t.endsAt, durationSec: t.durationSec });

function toTimer(r: Row): Timer {
  return { id: r.id, ownerId: r.owner_id, label: r.label, endsAt: r.ends_at, durationSec: r.duration_sec, fired: r.fired === 1 };
}

export function createTimer(db: ModuleDb, ownerId: UserId, input: { label: string; durationSec: number }, now: Date): Timer {
  const parsed = timerInput.safeParse(input);
  if (!parsed.success) throw new DashError('invalid', 'invalid timer', parsed.error.issues);
  const { label, durationSec } = parsed.data;
  const active = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_clock_timers WHERE owner_id = ? AND fired = 0', [ownerId])?.n ?? 0;
  if (active >= MAX_ACTIVE) throw new DashError('invalid', `You can have at most ${MAX_ACTIVE} running timers. Cancel one first.`);
  const id = newId(now);
  const endsAt = new Date(now.getTime() + durationSec * 1000).toISOString();
  db.run(
    'INSERT INTO m_clock_timers (id, owner_id, label, ends_at, duration_sec, fired, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [id, ownerId, label, endsAt, durationSec, now.toISOString()],
  );
  return { id, ownerId, label, endsAt, durationSec, fired: false };
}

/** Unfired timers whose end has passed. One indexed query on (fired, ends_at). */
export function dueTimers(db: ModuleDb, now: Date): Timer[] {
  return db
    .all<Row>(`SELECT ${COLUMNS} FROM m_clock_timers WHERE fired = 0 AND ends_at <= ? ORDER BY ends_at`, [now.toISOString()])
    .map(toTimer);
}

export function markFired(db: ModuleDb, id: string): void {
  db.run('UPDATE m_clock_timers SET fired = 1 WHERE id = ?', [id]);
}

/** The owner's running timers (unfired, not yet ended), soonest first. */
export function listTimers(db: ModuleDb, ownerId: UserId, now: Date): Timer[] {
  return db
    .all<Row>(
      `SELECT ${COLUMNS} FROM m_clock_timers WHERE owner_id = ? AND fired = 0 AND ends_at > ? ORDER BY ends_at LIMIT ?`,
      [ownerId, now.toISOString(), MAX_LISTED],
    )
    .map(toTimer);
}

/** Deletes the owner's timer; false when it does not exist or belongs to someone else. */
export function deleteTimer(db: ModuleDb, ownerId: UserId, id: string): boolean {
  return db.run('DELETE FROM m_clock_timers WHERE id = ? AND owner_id = ?', [id, ownerId]).changes > 0;
}

/** Drops fired rows that ended more than a day before `now` (indexed on fired, ends_at); returns the count. */
export function purgeFired(db: ModuleDb, now: Date): number {
  return db.run('DELETE FROM m_clock_timers WHERE fired = 1 AND ends_at < ?', [new Date(now.getTime() - PURGE_AFTER_MS).toISOString()]).changes;
}
