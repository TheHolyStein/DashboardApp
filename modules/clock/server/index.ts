import { DashError } from '@dash/contract';
import { abortable, defineServer } from '@dash/module-kit';
import manifest from '../manifest.js';
import { forget, hasPushed, nextKey, pushSnapshots, type NextEvent } from './snapshot.js';
import { createTimer, deleteTimer, dueTimers, listTimers, markFired, timerInput, type Timer } from './timers.js';

const toWire = (t: Timer) => ({ id: t.id, label: t.label, endsAt: t.endsAt, durationSec: t.durationSec });

export default defineServer({
  manifest,
  migrations: [
    {
      id: 1,
      up: `CREATE TABLE m_clock_timers (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        label TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        duration_sec INTEGER NOT NULL,
        fired INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
    },
    // Separate migration: the mock host runs one statement per migration (the real runner uses exec).
    { id: 2, up: 'CREATE INDEX m_clock_timers_due ON m_clock_timers (fired, ends_at)' },
  ],

  jobs: {
    // Every 5 s: fire due timers, drop past next-events, push snapshots that changed.
    tick: async ({ host, signal }) => {
      const now = host.now();
      const db = host.store.db;
      let dirty = false;

      for (const timer of dueTimers(db, now)) {
        markFired(db, timer.id); // first, so a crash after this cannot fire the timer twice
        host.bus.publish('timer.finished', { id: timer.id, label: timer.label });
        host.notify({
          level: 'info',
          title: timer.label || 'Timer finished',
          userIds: [timer.ownerId],
          dedupeKey: `timer:${timer.id}`,
        });
        dirty = true;
      }

      for (const key of await abortable(signal, host.store.keys('next:'))) {
        const event = await abortable(signal, host.store.get<NextEvent>(key));
        if (event && Date.parse(event.start) <= now.getTime()) {
          await abortable(signal, host.store.delete(key));
          dirty = true;
        }
      }

      const instances = await abortable(signal, host.instances());
      // Nothing changed: only instances never pushed since startup need a snapshot.
      await pushSnapshots(host, dirty ? instances : instances.filter((i) => !hasPushed(host, i.id)));
    },
  },

  on: {
    'calendar.event.upcoming': async (event, host) => {
      const start = Date.parse(event.start);
      const nowMs = host.now().getTime();
      if (Number.isNaN(start) || start <= nowMs) return;

      const changed = new Set<string>();
      for (const userId of event.userIds) {
        const stored = await host.store.get<NextEvent>(nextKey(userId));
        // Keep the soonest upcoming event: replace when nothing is stored, the stored one has
        // started, or the new one is earlier.
        const storedStart = stored ? Date.parse(stored.start) : Number.NaN;
        if (stored && storedStart > nowMs && storedStart <= start) continue;
        await host.store.set(nextKey(userId), { title: event.title, start: event.start });
        changed.add(userId);
      }
      if (changed.size === 0) return;
      await pushSnapshots(host, (await host.instances()).filter((i) => changed.has(i.ownerId)));
    },
  },

  onInstanceChange: async (kind, instance, host) => {
    if (kind === 'added') await pushSnapshots(host, [instance]);
    else if (kind === 'removed') forget(host, instance.id);
  },

  routes(r, host) {
    const pushFor = async (userId: string): Promise<void> => {
      await pushSnapshots(host, (await host.instances()).filter((i) => i.ownerId === userId));
    };

    r.get('/timers', { level: 'view' }, (req) =>
      Promise.resolve(listTimers(host.store.db, req.user.id, host.now()).map(toWire)),
    );

    r.post('/timers', { level: 'edit', body: timerInput }, async (req) => {
      const body = timerInput.parse(req.body); // already validated by the router; narrows the type
      const timer = createTimer(host.store.db, req.user.id, body, host.now());
      await pushFor(req.user.id);
      return toWire(timer);
    });

    r.delete('/timers/:id', { level: 'edit' }, async (req) => {
      // 404 for someone else's timer too: never reveal that it exists.
      if (!deleteTimer(host.store.db, req.user.id, req.params['id'] ?? '')) {
        throw new DashError('not_found', 'timer not found');
      }
      await pushFor(req.user.id);
      return undefined; // 204
    });
  },
});
