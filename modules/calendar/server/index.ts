import { z } from 'zod';
import { DashError, type HostServices, type UserId } from '@dash/contract';
import { defineServer } from '@dash/module-kit';
import manifest from '../manifest.js';
import {
  accessLevel,
  assertOwner,
  createCalendar,
  deleteCalendar,
  ensurePersonal,
  share,
  sharesOf,
  updateCalendar,
  visibleCalendars,
  type Access,
  type CalendarRow,
  type ShareLevel,
} from './calendars.js';
import { reconcile } from './derive.js';
import { migrations } from './migrations.js';
import { registerEventRoutes, type AfterWrite } from './routes-events.js';
import {
  NewSubscription,
  createSubscription,
  deleteSubscription,
  refreshSubscription,
  subscriptionCalendars,
} from './subscriptions.js';

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb');
const Name = z.string().trim().min(1).max(80);
const NewCalendar = z.object({ name: Name, color: Color });
const PatchCalendar = z.object({ name: Name.optional(), color: Color.optional() });
const Shares = z.object({
  shares: z.array(z.object({ userId: z.string().min(1), level: z.enum(['view', 'edit']) })).max(100),
});

export interface CalendarDto {
  id: string;
  name: string;
  color: string;
  kind: 'local' | 'subscription';
  sourceUrl: string | null;
  ownerId: string;
  access: Exclude<Access, 'none'>;
  /** Only the owner sees who a calendar is shared with. */
  shares: Array<{ userId: string; level: ShareLevel }> | null;
}

export function toCalendarDto(host: HostServices, row: CalendarRow, userId: UserId): CalendarDto {
  const access = accessLevel(host.store.db, row.id, userId);
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    kind: row.kind,
    sourceUrl: row.source_url,
    ownerId: row.owner_id,
    access: access === 'none' ? 'view' : access,
    shares: access === 'owner' ? sharesOf(host.store.db, row.id) : null,
  };
}

function createServer() {
  /** After a committed event write: publish, then re-derive and refresh snapshots (failures logged, not thrown). */
  const afterWrite: AfterWrite = async (host, changes) => {
    try {
      for (const c of changes) host.bus.publish('calendar.event.changed', c);
      await refresh(host);
    } catch (err) {
      host.log.error('calendar: refresh after a write failed', { err: String(err) });
    }
  };
  // Derive runs one at a time (the job and post-write hooks would otherwise diff against each other's half-done work).
  let chain: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const refresh = (host: HostServices): Promise<void> => serial(() => reconcile(host, host.now()));

  return defineServer({
    manifest,
    migrations,
    jobs: {
      // TODO(C6): reminders, event.upcoming / event.started, day summary.
      reminders: () => Promise.resolve(),
      // Derived items (todo.create.request, pin.request, countdown.request, reminders).
      derive: ({ host }) => refresh(host),
      // Read-only subscriptions: fetched one after another (they share host.http's limits), imported atomically each.
      subscriptions: async ({ host, signal }) => {
        const changes = [];
        for (const cal of subscriptionCalendars(host.store.db)) {
          if (signal.aborted) return;
          changes.push(...(await refreshSubscription(host, cal, signal)));
        }
        if (changes.length > 0) await afterWrite(host, changes);
      },
    },
    routes(r, host) {
      const db = host.store.db;
      // TODO(plan 08): CalDAV. The core mounts these prefixes (manifest.rootMounts) and authenticates with an app password.
      const notImplemented = (): Promise<{ status: number }> => Promise.resolve({ status: 501 });
      r.raw('/dav', notImplemented);
      r.raw('/.well-known/caldav', notImplemented);

      registerEventRoutes(r, host, afterWrite);

      r.post('/subscriptions', { level: 'edit', body: NewSubscription }, async (req) => {
        ensurePersonal(db, req.user.id, host.now());
        const row = createSubscription(db, req.user.id, req.body, host.now());
        // First import right away; a failure is reported to the owner and retried by the hourly job.
        const changes = await refreshSubscription(host, row);
        if (changes.length > 0) await afterWrite(host, changes);
        return toCalendarDto(host, row, req.user.id);
      });

      r.delete('/subscriptions/:id', { level: 'edit' }, async (req) => {
        const id = req.params['id'] ?? '';
        deleteSubscription(db, id, req.user.id);
        await refresh(host);
        return undefined;
      });

      r.get('/calendars', { level: 'view' }, (req) => {
        ensurePersonal(db, req.user.id, host.now());
        return { calendars: visibleCalendars(db, req.user.id).map((c) => toCalendarDto(host, c, req.user.id)) };
      });

      r.post('/calendars', { level: 'edit', body: NewCalendar }, (req) => {
        ensurePersonal(db, req.user.id, host.now());
        const row = createCalendar(db, req.user.id, req.body, { now: host.now() });
        return toCalendarDto(host, row, req.user.id);
      });

      r.patch('/calendars/:id', { level: 'edit', body: PatchCalendar }, (req) => {
        const row = updateCalendar(db, req.params['id'] ?? '', req.user.id, req.body);
        return toCalendarDto(host, row, req.user.id);
      });

      r.delete('/calendars/:id', { level: 'edit' }, (req) => {
        deleteCalendar(db, req.params['id'] ?? '', req.user.id);
        return undefined;
      });

      // Replaces the calendar's whole share list.
      r.put('/calendars/:id/shares', { level: 'edit', body: Shares }, async (req) => {
        const calendarId = req.params['id'] ?? '';
        const known = new Set((await host.users()).map((u) => u.id));
        const wanted = new Map<string, ShareLevel>();
        for (const s of req.body.shares) {
          if (!known.has(s.userId)) throw new DashError('invalid', `unknown user ${s.userId}`);
          wanted.set(s.userId, s.level);
        }
        db.transaction(() => {
          assertOwner(db, calendarId, req.user.id);
          for (const current of sharesOf(db, calendarId)) {
            if (!wanted.has(current.userId)) share(db, calendarId, req.user.id, current.userId, 'none');
          }
          for (const [userId, level] of wanted) share(db, calendarId, req.user.id, userId, level);
        });
        return { shares: sharesOf(db, calendarId) };
      });
    },
  });
}

export default createServer();
