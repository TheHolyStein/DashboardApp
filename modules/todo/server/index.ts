import { z } from 'zod';
import { DashError, TodoList, type EventName, type EventPayload, type HostServices } from '@dash/contract';
import { abortable, createSnapshotPusher, defineServer, newId, type SnapshotPusher } from '@dash/module-kit';
import manifest, { LISTS, type ItemList } from '../manifest.js';
import { bucketer } from './buckets.js';
import {
  accessible,
  clearDone,
  completeItem,
  createItem,
  deleteItem,
  isMine,
  purgeDone,
  reopenItem,
  toWire,
  updateItem,
  visibleItems,
  type Patch,
} from './items.js';
import { migrations } from './migrations.js';
import { applyCreateRequest, applyReadLater, applyRemoveRequest, type Applied } from './requests.js';
import { buildSnapshot, buildSummary, sortItems, type DaySummary } from './snapshot.js';

const REV_KEY = 'rev';
const ORDER_PREFIX = 'order:';
const TZ_PREFIX = 'tz:';
const PURGE_DONE_DAYS = 30;
const MAX_ORDER = 500;

const timeZoneField = z.string().max(64).optional();
const fields = {
  icon: z.string().max(32).nullish(),
  note: z.string().nullish(),
  qty: z.string().nullish(),
  due: z.string().max(40).nullish(),
  assigneeId: z.string().max(80).nullish(),
  /** The `@handle` of a user, resolved by the server (the client does not know ids). */
  assigneeHandle: z.string().max(64).nullish(),
  visibility: z.enum(['private', 'shared']).optional(),
  url: z.string().nullish(),
  repeatEvery: z.number().int().nullish(),
  repeatUnit: z.enum(['day', 'week', 'month']).nullish(),
  rotation: z.array(z.string().max(80)).optional(),
  timeZone: timeZoneField,
};
const NewBody = z.object({ list: TodoList, title: z.string(), ...fields });
const PatchBody = z.object({ version: z.number().int(), list: TodoList.optional(), title: z.string().optional(), ...fields });
const DoneBody = z.object({ version: z.number().int(), done: z.boolean(), timeZone: timeZoneField });
const VersionBody = z.object({ version: z.number().int() }).optional();
const VersionQuery = z.object({ version: z.coerce.number().int().optional() });
const ClearBody = z.object({ list: TodoList, timeZone: timeZoneField });
const OrderBody = z.object({ list: TodoList, ids: z.array(z.string()).max(MAX_ORDER), timeZone: timeZoneField });
const ListQuery = z.object({ list: TodoList.optional(), show: z.enum(['mine', 'all']).optional(), timeZone: timeZoneField });

type Change = { itemId: string; kind: 'created' | 'updated' | 'done' | 'deleted' };
type User = { id: string; name: string; handle: string };

interface State {
  pusher: SnapshotPusher;
  /** Names this boot: a client applies data from a new epoch even with a lower rev. */
  epoch: string;
  /**
   * One revision for all todo data (the items are shared between users, there is no per-user data to number
   * separately). THE RULE: raise it in the same synchronous step in which a change becomes visible (right after
   * the SQLite write), never before; snapshots read `{ epoch, rev }` before their first await.
   */
  rev: number;
  /** `<user>:<list>` -> the user's own order of item ids. Persisted in the store under `order:<user>:<list>`. */
  orders: Map<string, string[]>;
  /** The user's last reported time zone (`tz:<user>`). Needed for buckets in jobs and event handlers. */
  zones: Map<string, string>;
  /** Last published day summary per user, as JSON without the date: publish only when it changed. */
  summaries: Map<string, string>;
  /** The date of the last published non-empty summary per user. */
  summaryDates: Map<string, string>;
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function createServer() {
  let state: State | undefined;
  const need = (): State => {
    if (!state) throw new Error('todo: setup has not run');
    return state;
  };

  const stamp = (): { epoch: string; rev: number } => ({ epoch: need().epoch, rev: need().rev });
  /** Synchronous: call it right after the change it stands for is visible. */
  const bump = (): number => ++need().rev;
  /** Best effort: the in-memory value is already right; a failed write is logged. */
  const persistRev = async (host: HostServices, rev: number): Promise<void> => {
    try {
      await host.store.set(REV_KEY, rev);
    } catch (err) {
      host.log.error('todo: saving the revision failed', { err: String(err) });
    }
  };
  const zoneOf = (userId: string): string => need().zones.get(userId) ?? 'UTC';
  /** Remembers the zone a user's client reported (best effort persistence). */
  const learnZone = (host: HostServices, userId: string, zone: string | undefined): string => {
    const z = validZone(zone);
    if (!z) return zoneOf(userId);
    if (need().zones.get(userId) !== z) {
      need().zones.set(userId, z);
      host.store.set(TZ_PREFIX + userId, z).catch((err: unknown) => host.log.error('todo: saving the time zone failed', { err: String(err) }));
    }
    return z;
  };

  /** The caller's visible items with their stamp, read in one synchronous step. */
  const listOf = (host: HostServices, userId: string, zone: string): ItemList => {
    const s = need();
    const now = host.now();
    const bucketOf = bucketer(now, zone);
    const items = sortItems(visibleItems(host.store.db, userId), bucketOf).map((i) => toWire(i, bucketOf(i)));
    const order: ItemList['order'] = {};
    for (const list of LISTS) {
      const ids = s.orders.get(`${userId}:${list}`);
      if (!ids) continue;
      const seen = new Set(items.map((i) => i.id));
      const present = ids.filter((id) => seen.has(id));
      if (present.length > 0) order[list] = present;
    }
    return { ...stamp(), userId, items, order };
  };

  /** Rebuilds and pushes the snapshots (the pusher drops identical ones). */
  const pushAll = async (host: HostServices, signal?: AbortSignal): Promise<void> => {
    const wait = <T>(p: Promise<T>): Promise<T> => (signal ? abortable(signal, p) : p);
    const s = need();
    const st = stamp(); // before the first await
    const [instances, users] = await wait(Promise.all([host.instances(), host.users()]));
    const now = host.now();
    const built = instances.map((inst) => ({ inst, snap: buildSnapshot(host.store.db, inst, st, users, now, zoneOf(inst.ownerId)) }));
    const live = new Set((await wait(host.instances())).map((i) => i.id));
    for (const { inst, snap } of built) if (live.has(inst.id)) s.pusher.push(inst.id, snap);
  };

  /** Publishes `todo.day.summary` for every user whose summary changed (an empty one only to clear a non-empty one). */
  const publishSummaries = async (host: HostServices, signal?: AbortSignal): Promise<void> => {
    const s = need();
    const users: User[] = signal ? await abortable(signal, host.users()) : await host.users();
    const now = host.now();
    for (const u of users) {
      const summary: DaySummary = buildSummary(host.store.db, u.id, now, zoneOf(u.id));
      const key = JSON.stringify({ overdue: summary.overdue, due: summary.due });
      const empty = summary.overdue === 0 && summary.due.length === 0;
      const previous = s.summaries.get(u.id) ?? JSON.stringify({ overdue: 0, due: [] });
      const newDay = !empty && s.summaryDates.get(u.id) !== summary.date;
      if (key === previous && !newDay) continue;
      s.summaries.set(u.id, key);
      if (empty) s.summaryDates.delete(u.id);
      else s.summaryDates.set(u.id, summary.date);
      publish(host, 'todo.day.summary', summary);
    }
  };

  const publish = <E extends EventName>(host: HostServices, name: E, payload: EventPayload<E>): void => {
    try {
      host.bus.publish(name, payload);
    } catch (err) {
      host.log.error('todo: publishing an event failed', { name, err: String(err) });
    }
  };

  /** After a visible change: events, snapshots, day summaries. Failures are logged, never thrown into the request. */
  const afterChange = async (host: HostServices, changes: Change[]): Promise<void> => {
    for (const c of changes) publish(host, 'todo.changed', c);
    try {
      await pushAll(host);
      await publishSummaries(host);
    } catch (err) {
      host.log.error('todo: refreshing snapshots failed', { err: String(err) });
    }
  };

  /**
   * The follow-up of a change whose revision the caller already raised (`bump()` right after the write, then the
   * answer is built, then this): persist the revision, publish, push.
   */
  const finish = async (host: HostServices, changes: Change[], rev: number): Promise<void> => {
    const saved = persistRev(host, rev); // started before any await so writes stay in bump order
    await afterChange(host, changes);
    await saved;
  };

  const resolveAssignee = async (
    host: HostServices,
    body: { assigneeId?: string | null | undefined; assigneeHandle?: string | null | undefined },
  ): Promise<string | null | undefined> => {
    if (body.assigneeHandle) {
      const handle = body.assigneeHandle.replace(/^@/, '').toLowerCase();
      const user = (await host.users()).find((u) => u.handle.toLowerCase() === handle);
      if (!user) throw new DashError('invalid', `unknown user @${handle}`);
      return user.id;
    }
    if (body.assigneeId === undefined || body.assigneeId === null) return body.assigneeId;
    if (!(await host.users()).some((u) => u.id === body.assigneeId)) throw new DashError('invalid', 'unknown assignee');
    return body.assigneeId;
  };

  const applied = (a: Applied): Change => ({ itemId: a.item.id, kind: a.kind });

  return defineServer({
    manifest,
    migrations,

    async setup(host) {
      const orders = new Map<string, string[]>();
      for (const key of await host.store.keys(ORDER_PREFIX)) {
        const ids = await host.store.get<string[]>(key);
        if (Array.isArray(ids)) orders.set(key.slice(ORDER_PREFIX.length), ids);
      }
      const zones = new Map<string, string>();
      for (const key of await host.store.keys(TZ_PREFIX)) {
        const zone = await host.store.get<string>(key);
        if (typeof zone === 'string') zones.set(key.slice(TZ_PREFIX.length), zone);
      }
      const rev = await host.store.get<number>(REV_KEY);
      state = {
        pusher: createSnapshotPusher(host),
        epoch: newId(host.now()),
        rev: typeof rev === 'number' ? rev : 0,
        orders,
        zones,
        summaries: new Map(),
        summaryDates: new Map(),
      };
    },

    jobs: {
      // Every 15 min: time moves buckets (tomorrow becomes today), so snapshots and day summaries are rebuilt even
      // when no data changed; old done items are dropped.
      rollover: async ({ host, signal }) => {
        const removed = purgeDone(host.store.db, host.now(), PURGE_DONE_DAYS);
        if (removed > 0) await abortable(signal, persistRev(host, bump()));
        await pushAll(host, signal);
        await publishSummaries(host, signal);
      },
    },

    on: {
      'todo.create.request': async (req, host) => {
        const zone = req.assigneeId ? zoneOf(req.assigneeId) : 'UTC';
        const res = applyCreateRequest(host.store.db, req, host.now(), zone);
        if (res) await finish(host, [applied(res)], bump());
      },
      'todo.remove.request': async (req, host) => {
        const gone = applyRemoveRequest(host.store.db, req.sourceKey);
        if (gone) await finish(host, [{ itemId: gone.id, kind: 'deleted' }], bump());
      },
      'item.readLater': async (req, host) => {
        const res = applyReadLater(host.store.db, req, host.now());
        if (res) await finish(host, [applied(res)], bump());
      },
    },

    onInstanceChange: async (kind, instance, host) => {
      const s = need();
      if (kind === 'removed') s.pusher.forget(instance.id);
      else await pushAll(host);
    },

    routes(r, host) {
      const db = host.store.db;

      r.get('/users', { level: 'view' }, () => host.users());

      r.get('/items', { level: 'view', query: ListQuery }, (req) => {
        const zone = learnZone(host, req.user.id, req.query.timeZone);
        const all = listOf(host, req.user.id, zone);
        const { list, show } = req.query;
        if (!list && show !== 'mine') return all;
        return {
          ...all,
          items: all.items.filter(
            (i) => (!list || i.list === list) && (show !== 'mine' || isMine({ assigneeId: i.assigneeId }, req.user.id)),
          ),
        };
      });

      r.post('/items', { level: 'edit', body: NewBody }, async (req) => {
        const b = req.body;
        const zone = learnZone(host, req.user.id, b.timeZone);
        const assigneeId = await resolveAssignee(host, b);
        const patch: Patch = {
          icon: b.icon,
          note: b.note,
          qty: b.qty,
          due: b.due,
          visibility: b.visibility,
          url: b.url,
          repeatEvery: b.repeatEvery,
          repeatUnit: b.repeatUnit,
          rotation: b.rotation,
        };
        const item = createItem(db, { ...patch, list: b.list, title: b.title, ownerId: req.user.id, assigneeId }, host.now(), zone);
        const rev = bump();
        const list = { ...listOf(host, req.user.id, zone), itemId: item.id }; // before the first await
        await finish(host, [{ itemId: item.id, kind: 'created' }], rev);
        return list;
      });

      r.patch('/items/:id', { level: 'edit', body: PatchBody }, async (req) => {
        const { version, timeZone, assigneeHandle, ...rest } = req.body;
        const zone = learnZone(host, req.user.id, timeZone);
        const assigneeId = await resolveAssignee(host, { assigneeId: rest.assigneeId, assigneeHandle });
        const patch: Patch = { ...stripUndefined(rest), ...(assigneeId === undefined ? {} : { assigneeId }) };
        const item = updateItem(db, req.params['id'] ?? '', req.user.id, version, patch, host.now(), zone);
        const rev = bump();
        const list = listOf(host, req.user.id, zone);
        await finish(host, [{ itemId: item.id, kind: 'updated' }], rev);
        return list;
      });

      r.post('/items/:id/done', { level: 'edit', body: DoneBody }, async (req) => {
        const { version, done, timeZone } = req.body;
        const zone = learnZone(host, req.user.id, timeZone);
        const id = req.params['id'] ?? '';
        const changes: Change[] = [];
        if (done) {
          const res = completeItem(db, id, req.user.id, version, host.now(), zone);
          // Done on an already-done item changes nothing and reports nothing.
          if (res.item.version !== version) changes.push({ itemId: id, kind: 'done' });
          if (res.next) changes.push({ itemId: res.next.id, kind: 'created' });
        } else {
          const before = accessible(db, id, req.user.id);
          const item = reopenItem(db, id, req.user.id, version, host.now(), zone);
          if (before.done) changes.push({ itemId: item.id, kind: 'updated' });
        }
        const rev = changes.length > 0 ? bump() : need().rev;
        const list = listOf(host, req.user.id, zone);
        if (changes.length > 0) await finish(host, changes, rev);
        return list;
      });

      r.delete('/items/:id', { level: 'edit', body: VersionBody, query: VersionQuery }, async (req) => {
        // ModuleApi.delete sends no body, so the version may come as `?version=`.
        const version = req.body?.version ?? req.query.version;
        if (version === undefined) throw new DashError('invalid', 'version is required');
        const zone = zoneOf(req.user.id);
        const item = deleteItem(db, req.params['id'] ?? '', req.user.id, version, host.now(), zone);
        const rev = bump();
        const list = listOf(host, req.user.id, zone);
        await finish(host, [{ itemId: item.id, kind: 'deleted' }], rev);
        return list;
      });

      r.post('/items/clear-done', { level: 'edit', body: ClearBody }, async (req) => {
        const zone = learnZone(host, req.user.id, req.body.timeZone);
        const ids = clearDone(db, req.user.id, req.body.list, host.now());
        const rev = ids.length > 0 ? bump() : need().rev;
        const list = listOf(host, req.user.id, zone);
        if (ids.length > 0) await finish(host, ids.map((itemId) => ({ itemId, kind: 'deleted' as const })), rev);
        return list;
      });

      // The caller's own order of one list. Not a change to the shared data: no new rev, no snapshot.
      r.put('/order', { level: 'edit', body: OrderBody }, async (req) => {
        const zone = learnZone(host, req.user.id, req.body.timeZone);
        const seen = new Set(visibleItems(db, req.user.id).filter((i) => i.list === req.body.list).map((i) => i.id));
        const ids = [...new Set(req.body.ids)].filter((id) => seen.has(id));
        need().orders.set(`${req.user.id}:${req.body.list}`, ids);
        const list = listOf(host, req.user.id, zone);
        await host.store.set(`${ORDER_PREFIX}${req.user.id}:${req.body.list}`, ids);
        return list;
      });
    },
  });
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export default createServer();
