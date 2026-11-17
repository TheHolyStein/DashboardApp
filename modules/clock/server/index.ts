import { DashError, type HostServices } from '@dash/contract';
import { abortable, createSnapshotPusher, defineServer, type SnapshotPusher } from '@dash/module-kit';
import manifest from '../manifest.js';
import { nextKey, pushSnapshots, type NextEvent } from './snapshot.js';
import { normaliseZones, zonesInput, zonesKey } from './zones.js';
import { createTimer, deleteTimer, dueTimers, listTimers, markFired, purgeFired, timerInput, toWire } from './timers.js';

const PURGE_EVERY_MS = 3_600_000;

/** Per-host working state: the snapshot pusher and two cheap flags that let an idle tick return early. */
interface State {
  host: HostServices;
  pusher: SnapshotPusher;
  /** False until the first tick has pushed every instance once. */
  started: boolean;
  /** Whether any `next:<user>` key may exist; null until the first tick rebuilds it from the store. */
  hasNext: boolean | null;
  lastPurge: number;
}

function createClockServer() {
  // One registration serves one host; the slot is rebuilt when a different host (a test, a restart) shows up.
  let state: State | undefined;
  const stateFor = (host: HostServices): State => {
    if (state?.host !== host) state = { host, pusher: createSnapshotPusher(host), started: false, hasNext: null, lastPurge: 0 };
    return state;
  };

  return defineServer({
    manifest,
    // The module has never shipped, so table and indexes are one migration.
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
        );
        CREATE INDEX m_clock_timers_due ON m_clock_timers (fired, ends_at);
        CREATE INDEX m_clock_timers_owner ON m_clock_timers (owner_id, fired, ends_at);`,
      },
    ],

    jobs: {
      // Every 5 s: fire due timers, drop past next-events, push snapshots that changed. Idle ticks return early.
      tick: async ({ host, signal }) => {
        const s = stateFor(host);
        const now = host.now();
        const db = host.store.db;

        if (now.getTime() - s.lastPurge >= PURGE_EVERY_MS) {
          s.lastPurge = now.getTime();
          purgeFired(db, now);
        }
        s.hasNext ??= (await abortable(signal, host.store.keys('next:'))).length > 0;

        const due = dueTimers(db, now);
        if (s.started && due.length === 0 && !s.hasNext) return; // nothing to fire, nothing to expire

        let dirty = !s.started;
        for (const timer of due) {
          markFired(db, timer.id); // first, so a crash after this cannot fire the timer twice
          dirty = true; // right after, so a failing publish/notify below still refreshes the snapshots
          try {
            host.bus.publish('timer.finished', { id: timer.id, label: timer.label });
          } catch (err) {
            host.log.error('clock: publishing timer.finished failed', { timer: timer.id, err: String(err) });
          }
          try {
            host.notify({
              level: 'info',
              title: timer.label || 'Timer finished',
              titleKey: 'm.clock.notify.finished',
              vars: { label: timer.label },
              userIds: [timer.ownerId],
              dedupeKey: `timer:${timer.id}`,
            });
          } catch (err) {
            host.log.error('clock: notifying a finished timer failed', { timer: timer.id, err: String(err) });
          }
        }

        if (s.hasNext) {
          const keys = await abortable(signal, host.store.keys('next:'));
          let remaining = keys.length;
          for (const key of keys) {
            const event = await abortable(signal, host.store.get<NextEvent>(key));
            if (event && Date.parse(event.start) <= now.getTime()) {
              await abortable(signal, host.store.delete(key));
              remaining--;
              dirty = true;
            }
          }
          s.hasNext = remaining > 0;
        }

        if (!dirty) return;
        s.started = true;
        await pushSnapshots(host, s.pusher, await abortable(signal, host.instances()), signal);
      },
    },

    on: {
      'calendar.event.upcoming': async (event, host) => {
        const s = stateFor(host);
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
          s.hasNext = true;
          changed.add(userId);
        }
        if (changed.size === 0) return;
        await pushSnapshots(host, s.pusher, (await host.instances()).filter((i) => changed.has(i.ownerId)));
      },
    },

    onInstanceChange: async (kind, instance, host) => {
      const s = stateFor(host);
      if (kind === 'removed') s.pusher.forget(instance.id);
      else if (kind === 'added') await pushSnapshots(host, s.pusher, [instance]);
    },

    routes(r, host) {
      const s = stateFor(host);
      const pushFor = async (userId: string): Promise<void> => {
        await pushSnapshots(host, s.pusher, (await host.instances()).filter((i) => i.ownerId === userId));
      };

      r.get('/timers', { level: 'view' }, (req) => listTimers(host.store.db, req.user.id, host.now()).map(toWire));

      r.post('/timers', { level: 'edit', body: timerInput }, async (req) => {
        const timer = createTimer(host.store.db, req.user.id, req.body, host.now());
        await pushFor(req.user.id);
        return toWire(timer);
      });

      // The caller's own world-clock list; empty until they save one.
      r.get('/zones', { level: 'view' }, async (req) => (await host.store.get<string[]>(zonesKey(req.user.id))) ?? []);

      r.put('/zones', { level: 'edit', body: zonesInput }, async (req) => {
        const zones = normaliseZones(req.body.zones);
        await host.store.set(zonesKey(req.user.id), zones);
        return zones;
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
}

export default createClockServer();
