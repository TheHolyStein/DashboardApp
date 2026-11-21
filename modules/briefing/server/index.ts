import type { EventPayload, HostServices, UserId } from '@dash/contract';
import { abortable, createSnapshotPusher, defineServer, newId, type SnapshotPusher } from '@dash/module-kit';
import manifest, { settings as settingsSchema, type DayDetail, type Snapshot } from '../manifest.js';
import { compose, composeDay, localDate } from './compose.js';
import { emptyState, ownPart, prune, withAlert, withCalendar, withPin, withTodos, withUpcoming, type SystemState, type UserState, type WeatherState } from './state.js';

const USER_PREFIX = 'u:';
const REV_PREFIX = 'rev:';
const GLOBAL_KEY = 'g';
const DEFAULT_TZ = 'UTC';

/** Household-wide conditions and weather: the events that carry them name no user, so every briefing shows them. */
interface GlobalState {
  weather?: WeatherState;
  system?: SystemState;
}

/**
 * Working state of one set-up host. Per-user state is not kept here: it lives in `host.store` (`u:<userId>`), so a
 * restart loses nothing but the pusher memory.
 */
interface Runtime {
  pusher: SnapshotPusher;
  /** Names this boot: a client applies data from a new epoch even when its `rev` is lower. */
  epoch: string;
  /** Per-user revision of the composed briefing; raised only when what the user would see changes. */
  revs: Map<UserId, number>;
  /** JSON of what each user last saw (briefing and agenda); a different one raises the rev. */
  seen: Map<UserId, string>;
  /** Tail of each user's work queue; see `locked`. */
  queues: Map<string, Promise<unknown>>;
}

function createBriefingServer() {
  let rt: Runtime | undefined;
  const need = (): Runtime => {
    if (!rt) throw new Error('briefing: setup has not run');
    return rt;
  };

  /**
   * Runs `fn` after everything queued before it for the same key. Every read-modify-write of a user's state and
   * every publish for that user goes through here, so two events for one user never overwrite each other and a
   * later snapshot never carries older content than an earlier one.
   */
  function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const { queues } = need();
    const run = (queues.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  const userKey = (id: UserId): string => USER_PREFIX + id;

  async function loadOwn(host: HostServices, id: UserId): Promise<UserState> {
    const stored = await host.store.get<Partial<UserState>>(userKey(id));
    return { ...emptyState(), ...stored };
  }
  const loadGlobal = async (host: HostServices): Promise<GlobalState> => (await host.store.get<GlobalState>(GLOBAL_KEY)) ?? {};

  /** Time zone of the user's briefing instance; UTC when they have none (yet). */
  function tzOf(instances: Array<{ ownerId: UserId; settings: unknown }>, id: UserId): string {
    const mine = instances.find((i) => i.ownerId === id);
    const parsed = mine ? settingsSchema.safeParse(mine.settings) : undefined;
    return parsed?.success ? parsed.data.timeZone : DEFAULT_TZ;
  }

  async function persistRev(host: HostServices, id: UserId, rev: number): Promise<void> {
    try {
      await host.store.set(REV_PREFIX + id, rev);
    } catch (err) {
      host.log.error('briefing: saving the revision failed', { err: String(err) });
    }
  }

  /**
   * Composes the user's briefing and pushes it to their instances. Call inside `locked(userId, …)`. The only awaits
   * are the reads; composing, raising the rev and pushing happen in one synchronous step after them.
   */
  async function publish(host: HostServices, id: UserId): Promise<void> {
    const own = await loadOwn(host, id);
    const global = await loadGlobal(host);
    const instances = (await host.instances<unknown>()).filter((i) => i.ownerId === id);
    if (instances.length === 0) return;
    const now = host.now();
    const tz = tzOf(instances, id);
    const full: UserState = { ...prune(own, now, tz), ...global };
    const briefing = compose(full, now, tz);
    const { epoch, pusher, revs, seen } = need();
    const json = JSON.stringify([briefing, composeDay(full, now, tz)]);
    let rev = revs.get(id) ?? 0;
    let raised = false;
    if (seen.get(id) !== json) {
      rev += 1;
      revs.set(id, rev);
      seen.set(id, json);
      raised = true;
    }
    const snapshot: Snapshot = { epoch, rev, ...briefing };
    for (const instance of instances) pusher.push(instance.id, snapshot);
    if (raised) await persistRev(host, id, rev);
  }

  /** Reads, prunes, changes and stores one user's state, then publishes it. `change` gets the user's local date. */
  function updateUser(host: HostServices, id: UserId, change: (s: UserState, today: string, nowMs: number) => UserState): Promise<void> {
    return locked(id, async () => {
      const now = host.now();
      const tz = tzOf(await host.instances<unknown>(), id);
      const own = prune(await loadOwn(host, id), now, tz);
      await host.store.set(userKey(id), ownPart(change(own, localDate(now, tz), now.getTime())));
      await publish(host, id);
    });
  }

  /** Several users at once (events with `userIds`): each one is updated and published on its own. */
  const updateUsers = async (
    host: HostServices,
    ids: UserId[],
    change: (s: UserState, today: string, nowMs: number) => UserState,
  ): Promise<void> => {
    for (const id of new Set(ids)) await updateUser(host, id, change);
  };

  /** Changes the household state, then republishes every user's briefing. */
  async function updateGlobal(host: HostServices, change: (g: GlobalState) => GlobalState): Promise<void> {
    await locked(GLOBAL_KEY, async () => {
      await host.store.set(GLOBAL_KEY, change(await loadGlobal(host)));
    });
    await publishAll(host);
  }

  async function publishAll(host: HostServices, signal?: AbortSignal): Promise<void> {
    const wait = <T>(p: Promise<T>): Promise<T> => (signal ? abortable(signal, p) : p);
    const owners = new Set((await wait(host.instances())).map((i) => i.ownerId));
    for (const id of owners) await wait(refreshUser(host, id));
  }

  /** Drops what expired from the stored state, then publishes: the clock moved on even if no event arrived. */
  function refreshUser(host: HostServices, id: UserId): Promise<void> {
    return locked(id, async () => {
      const now = host.now();
      const tz = tzOf(await host.instances<unknown>(), id);
      const own = await loadOwn(host, id);
      const pruned = prune(own, now, tz);
      if (JSON.stringify(pruned) !== JSON.stringify(own)) await host.store.set(userKey(id), ownPart(pruned));
      await publish(host, id);
    });
  }

  /** The agenda the detail pane shows, for the caller only. */
  async function dayFor(host: HostServices, id: UserId): Promise<DayDetail> {
    const { epoch, revs } = need();
    const rev = revs.get(id) ?? 0; // read before the first await: content may be newer than its rev, never older
    const own = await loadOwn(host, id);
    const global = await loadGlobal(host);
    const now = host.now();
    const tz = tzOf(await host.instances<unknown>(), id);
    return { epoch, rev, ...composeDay({ ...prune(own, now, tz), ...global }, now, tz) };
  }

  return defineServer({
    manifest,

    async setup(host) {
      const revs = new Map<UserId, number>();
      const owners = new Set((await host.instances()).map((i) => i.ownerId));
      // Reconcile: state of users who have no briefing any more would otherwise stay for ever.
      for (const key of await host.store.keys(USER_PREFIX)) {
        if (!owners.has(key.slice(USER_PREFIX.length))) await host.store.delete(key);
      }
      for (const key of await host.store.keys(REV_PREFIX)) {
        const id = key.slice(REV_PREFIX.length);
        const rev = await host.store.get<number>(key);
        if (!owners.has(id)) await host.store.delete(key);
        else if (typeof rev === 'number') revs.set(id, rev);
      }
      rt = { pusher: createSnapshotPusher(host), epoch: newId(host.now()), revs, seen: new Map(), queues: new Map() };
    },

    jobs: {
      // Every minute while someone looks: the clock moves minutesUntil, greeting, pins and alert ages on.
      compose: async ({ host, signal }) => {
        await publishAll(host, signal);
      },
    },

    on: {
      'calendar.day.summary': async (event, host) => {
        await updateUser(host, event.userId, (s) => withCalendar(s, event));
      },
      'calendar.event.upcoming': async (event, host) => {
        await updateUsers(host, event.userIds, (s, _today, nowMs) => withUpcoming(s, event, nowMs));
      },
      'todo.day.summary': async (event, host) => {
        await updateUser(host, event.userId, (s) => withTodos(s, event));
      },
      'pin.request': async (event, host) => {
        await updateUsers(host, event.userIds, (s, today) => withPin(s, event, today));
      },
      // The event names its user, so only that user's alerts change.
      'notification.created': async (event, host) => {
        if (event.level === 'info') return;
        await updateUser(host, event.userId, (s) => withAlert(s, event));
      },
      // Weather, connectivity and NAS health are about the household: no user in the payload, everyone's briefing changes.
      'weather.updated': async (event: EventPayload<'weather.updated'>, host) => {
        const at = host.now().toISOString();
        await updateGlobal(host, (g) => ({
          ...g,
          weather: { condition: event.condition, tempC: event.tempC, nextPrecip: event.nextPrecip, pollenMax: event.pollenMax, at },
        }));
      },
      'net.connectivity.changed': async (event, host) => {
        await updateGlobal(host, (g) => {
          const system: SystemState = {};
          if (g.system?.nas) system.nas = g.system.nas;
          if (!event.online) system.netOffline = { since: event.since };
          return { ...g, system };
        });
      },
      'nas.health.changed': async (event, host) => {
        const at = host.now().toISOString();
        await updateGlobal(host, (g) => {
          const system: SystemState = {};
          if (g.system?.netOffline) system.netOffline = g.system.netOffline;
          if (event.status !== 'ok') system.nas = { status: event.status, detail: event.detail, at };
          return { ...g, system };
        });
      },
    },

    onInstanceChange: async (kind, instance, host) => {
      const owner = instance.ownerId;
      if (kind === 'removed') {
        need().pusher.forget(instance.id);
        await locked(owner, async () => {
          if ((await host.instances()).some((i) => i.ownerId === owner && i.id !== instance.id)) return;
          await host.store.delete(userKey(owner));
          await host.store.delete(REV_PREFIX + owner);
          need().revs.delete(owner);
          need().seen.delete(owner);
        });
      } else {
        await refreshUser(host, owner);
      }
    },

    routes(r, host) {
      r.get('/day', { level: 'view' }, (req) => dayFor(host, req.user.id));
    },
  });
}

export default createBriefingServer();
