import { z } from 'zod';
import { DashError, type HostServices, type ModuleDb, type UserId } from '@dash/contract';
import { createCalendar, deleteCalendar, getCalendar, type CalendarRow } from './calendars.js';
import { deleteEvent, upsertEvent } from './events-repo.js';
import { splitFeed } from './ical.js';
import type { EventChange } from './routes-events.js';

export const NewSubscription = z.object({
  name: z.string().trim().min(1).max(80),
  url: z
    .string()
    .trim()
    .max(2000)
    .transform((u) => u.replace(/^webcals?:\/\//i, 'https://'))
    .pipe(z.url({ protocol: /^https?$/ })),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb'),
});

export const FETCH = { rule: 'publicUrl', as: 'text', ttlSec: 3000, maxBytes: 5_000_000 } as const;

export function createSubscription(db: ModuleDb, ownerId: UserId, input: z.infer<typeof NewSubscription>, now: Date): CalendarRow {
  return createCalendar(db, ownerId, { name: input.name, color: input.color }, { now, kind: 'subscription', sourceUrl: input.url });
}

/** Deletes a subscription calendar; owner only, and only subscriptions (local calendars go through /calendars). */
export function deleteSubscription(db: ModuleDb, calendarId: string, ownerId: UserId): void {
  const cal = getCalendar(db, calendarId);
  if (cal && cal.kind !== 'subscription') throw new DashError('not_found', 'subscription not found');
  deleteCalendar(db, calendarId, ownerId);
}

/**
 * Replaces a subscription calendar's events with the feed's, in one transaction: resources that vanished are
 * deleted, changed ones rewritten, unchanged ones left alone. Throws (and changes nothing) when the feed is unreadable.
 */
export function importFeed(db: ModuleDb, cal: CalendarRow, text: string, now: Date): EventChange[] {
  const resources = splitFeed(text);
  return db.transaction(() => {
    const changes: EventChange[] = [];
    const current = new Map(
      db
        .all<{ uid: string; etag: string }>('SELECT DISTINCT uid, etag FROM m_calendar_events WHERE calendar_id = ?', [cal.id])
        .map((r) => [r.uid, r.etag]),
    );
    const wanted = new Set(resources.map((r) => r.uid));
    for (const uid of current.keys()) {
      if (wanted.has(uid)) continue;
      deleteEvent(db, cal.id, uid, { now });
      changes.push({ uid, calendarId: cal.id, kind: 'deleted' });
    }
    for (const r of resources) {
      const had = current.get(r.uid);
      const res = upsertEvent(db, cal.id, r.ics, { creatorId: cal.owner_id, now, ifMatch: null });
      if (had === undefined) changes.push({ uid: r.uid, calendarId: cal.id, kind: 'created' });
      else if (had !== res.etag) changes.push({ uid: r.uid, calendarId: cal.id, kind: 'updated' });
    }
    return changes;
  });
}

const failKey = (calendarId: string): string => `subscription-failed:${calendarId}`;

/** Fetches and imports one subscription. Failures keep the old events and notify the owner once until it works again. */
export async function refreshSubscription(host: HostServices, cal: CalendarRow, signal?: AbortSignal): Promise<EventChange[]> {
  if (!cal.source_url) return [];
  try {
    const res = await host.http.fetch<string>(cal.source_url, FETCH);
    if (signal?.aborted) return [];
    if (res.status < 200 || res.status >= 300) throw new DashError('upstream', `HTTP ${res.status}`);
    if (typeof res.data !== 'string') throw new DashError('upstream', 'not a text response');
    const changes = importFeed(host.store.db, cal, res.data, host.now());
    if ((await host.store.get(failKey(cal.id))) !== undefined) await host.store.delete(failKey(cal.id));
    return changes;
  } catch (err) {
    if (signal?.aborted) return [];
    const message = err instanceof Error ? err.message : String(err);
    host.log.warn('calendar: subscription refresh failed', { calendarId: cal.id, err: message });
    if ((await host.store.get(failKey(cal.id))) === undefined) {
      await host.store.set(failKey(cal.id), { at: host.now().toISOString(), message });
      host.notify({
        level: 'warn',
        title: `Calendar subscription "${cal.name}" could not be updated`,
        body: message.slice(0, 300),
        titleKey: 'calendar.subscription.failed',
        vars: { name: cal.name },
        dedupeKey: `calendar:subscription:${cal.id}`,
        userIds: [cal.owner_id],
      });
    }
    return [];
  }
}

export function subscriptionCalendars(db: ModuleDb): CalendarRow[] {
  return db.all<CalendarRow>("SELECT * FROM m_calendar_calendars WHERE kind = 'subscription' ORDER BY created_at, id");
}
