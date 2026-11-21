import { DashError, type HostServices, type UserId } from '@dash/contract';
import { abortable, createSnapshotPusher, defineServer, type SnapshotPusher } from '@dash/module-kit';
import manifest, { type TimerList } from '../manifest.js';
import { nextKey, pushSnapshots, type NextEvent } from './snapshot.js';
import { normaliseZones, zonesInput, zonesKey } from './zones.js';
import { createTimer, deleteTimer, dueTimers, listTimers, markFired, purgeFired, timerInput, toWire } from './timers.js';

const PURGE_EVERY_MS = 3_600_000;
const REV_PREFIX = 'rev:';

/** Working state of one set-up host: the snapshot pusher and a few cheap flags that let an idle tick return early. */
interface State {
  pusher: SnapshotPusher;
  /** False until the first tick has pushed every instance once (and that push succeeded). */
  started: boolean;
  /** Whether any `next:<user>` key may exist; null until the first tick rebuilds it from the store. */
  hasNext: boolean | null;
  /** Bumped on every `next:` write; a scan only trusts its own "nothing left" result when this did not move meanwhile. */
  nextSeq: number;
  lastPurge: number;
  /**
   * Per-owner revision: raised in the same synchronous step as every change to that owner's timers or next
   * event, and carried by every snapshot and list response so clients can drop anything older than what they hold.
   * Persisted as `rev:<userId>` so it never goes backwards across a restart.
   */
  revs: Map<UserId, number>;
}

function createClockServer() {
  // Created in `setup(host)`, which the loader runs once before any job, handler or route.
  let state: State | undefined;
  const need = (): State => {
    if (!state) throw new Error('clock: setup has not run');
    return state;
  };

  const revOf = (owner: UserId): number => need().revs.get(owner) ?? 0;
  /** Synchronous: call it in the same step as the change it stands for, then `persistRev` before any await. */
  const bump = (owner: UserId): number => {
    const rev = revOf(owner) + 1;
    need().revs.set(owner, rev);
    return rev;
  };
  /** Best effort: the in-memory value is already right; a failed write is logged and the next bump rewrites it. */
  const persistRev = async (host: HostServices, owner: UserId, rev: number): Promise<void> => {
    try {
      await host.store.set(REV_PREFIX + owner, rev);
    } catch (err) {
      host.log.error('clock: saving the revision failed', { user: owner, err: String(err) });
    }
  };
  /** The caller's full current list with the revision it belongs to, read in one synchronous step. */
  const listOf = (host: HostServices, owner: UserId): TimerList => ({
    rev: revOf(owner),
    timers: listTimers(host.store.db, owner, host.now()).map(toWire),
  });

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

    async setup(host) {
      const revs = new Map<UserId, number>();
      for (const key of await host.store.keys(REV_PREFIX)) {
        const rev = await host.store.get<number>(key);
        if (typeof rev === 'number') revs.set(key.slice(REV_PREFIX.length), rev);
      }
      state = { pusher: createSnapshotPusher(host), started: false, hasNext: null, nextSeq: 0, lastPurge: 0, revs };
    },

    jobs: {
      // Every 5 s: fire due timers, drop past next-events, push snapshots that changed. Idle ticks return early.
      tick: async ({ host, signal }) => {
        const s = need();
        const now = host.now();
        const db = host.store.db;

        if (now.getTime() - s.lastPurge >= PURGE_EVERY_MS) {
          s.lastPurge = now.getTime();
          try {
            purgeFired(db, now);
          } catch (err) {
            host.log.error('clock: purging fired timers failed', { err: String(err) });
          }
        }
        if (s.hasNext === null) {
          const found = (await abortable(signal, host.store.keys('next:'))).length > 0;
          // A handler that wrote meanwhile already set it to true: only fill in an unknown value.
          if (s.hasNext === null) s.hasNext = found;
        }

        const due = dueTimers(db, now);
        if (s.started && due.length === 0 && !s.hasNext) return; // nothing to fire, nothing to expire

        let dirty = !s.started;
        for (const timer of due) {
          markFired(db, timer.id); // first, so a crash after this cannot fire the timer twice
          const rev = bump(timer.ownerId);
          const saved = persistRev(host, timer.ownerId, rev);
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
          await abortable(signal, saved);
        }

        if (s.hasNext) {
          const seq = s.nextSeq;
          const keys = await abortable(signal, host.store.keys('next:'));
          let remaining = keys.length;
          for (const key of keys) {
            const event = await abortable(signal, host.store.get<NextEvent>(key));
            if (event && Date.parse(event.start) <= now.getTime()) {
              await abortable(signal, host.store.delete(key));
              const owner = key.slice('next:'.length);
              await abortable(signal, persistRev(host, owner, bump(owner)));
              remaining--;
              dirty = true;
            }
          }
          // A handler write during the scan may not be in `keys`: then only the handler knows, keep the flag.
          if (s.nextSeq === seq) s.hasNext = remaining > 0;
        }

        if (!dirty) return;
        await pushSnapshots(host, s.pusher, await abortable(signal, host.instances()), revOf, signal);
        s.started = true; // only after the push succeeded, so a failed startup push is retried
      },
    },

    on: {
      'calendar.event.upcoming': async (event, host) => {
        const s = need();
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
          s.nextSeq++;
          s.hasNext = true;
          await host.store.set(nextKey(userId), { title: event.title, start: event.start });
          s.nextSeq++;
          await persistRev(host, userId, bump(userId));
          changed.add(userId);
        }
        if (changed.size === 0) return;
        await pushSnapshots(host, s.pusher, (await host.instances()).filter((i) => changed.has(i.ownerId)), revOf);
      },
    },

    onInstanceChange: async (kind, instance, host) => {
      const s = need();
      if (kind === 'removed') s.pusher.forget(instance.id);
      else if (kind === 'added') await pushSnapshots(host, s.pusher, [instance], revOf);
    },

    routes(r, host) {
      const pushFor = async (userId: string): Promise<void> => {
        await pushSnapshots(host, need().pusher, (await host.instances()).filter((i) => i.ownerId === userId), revOf);
      };

      r.get('/timers', { level: 'view' }, (req) => listOf(host, req.user.id));

      r.post('/timers', { level: 'edit', body: timerInput }, async (req) => {
        createTimer(host.store.db, req.user.id, req.body, host.now());
        // Change, revision and the list to answer with happen in one synchronous step: nothing can slip in between.
        const rev = bump(req.user.id);
        const list = listOf(host, req.user.id);
        await persistRev(host, req.user.id, rev); // started before any await, so writes stay in bump order
        await pushFor(req.user.id);
        return list;
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
        const rev = bump(req.user.id);
        const list = listOf(host, req.user.id);
        await persistRev(host, req.user.id, rev); // started before any await, so writes stay in bump order
        await pushFor(req.user.id);
        return list;
      });
    },
  });
}

export default createClockServer();
