import { z } from 'zod';
import { DashError, type HostServices, type NotificationRecord, type UserId } from '@dash/contract';
import { createSnapshotPusher, defineServer, newId, type SnapshotPusher } from '@dash/module-kit';
import manifest, { type ListPage, type MutesState, type ReadResult, type Snapshot } from '../manifest.js';

const REV_PREFIX = 'rev:';
const PAGE = 50;
/** The privileged list call never returns more than this per page. */
const LIST_MAX = 100;
/** Safety bound for paging through unread notifications (retention keeps the real number far lower). */
const MAX_PAGES = 100;
const LATEST = 5;

const ModuleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
const ListQuery = z.object({
  before: z.string().max(40).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  moduleId: ModuleIdSchema.optional(),
});
const ReadBody = z.object({ ids: z.union([z.literal('all'), z.array(z.string().max(64)).max(500)]) });
const MuteBody = z.object({
  moduleId: ModuleIdSchema,
  /** How long to mute: a duration the server turns into a time with its own clock; null removes the mute. */
  hours: z.union([z.literal(1), z.literal(8), z.literal(24), z.literal('forever'), z.null()]),
});

type Service = NonNullable<HostServices['notifications']>;

/** Per-host state of one set-up module. The notifications themselves live in core; only revisions are kept here. */
interface State {
  pusher: SnapshotPusher;
  /** Names this boot: a client applies data from a new epoch even if its rev is lower. */
  epoch: string;
  /** Per-user revision: raised whenever the user's notifications, read state or mutes change. */
  revs: Map<UserId, number>;
}

function createNotificationsServer() {
  let state: State | undefined;
  const need = (): State => {
    if (!state) throw new Error('notifications: setup has not run');
    return state;
  };

  /** The privileged service, or an error: the module is only useful when core allow-lists its id. */
  const serviceOf = (host: HostServices): Service => {
    if (!host.notifications) throw new DashError('internal', 'the notification service is not available to this module');
    return host.notifications;
  };

  const stampOf = (owner: UserId): { epoch: string; rev: number } => ({ epoch: need().epoch, rev: need().revs.get(owner) ?? 0 });

  /** Synchronous: call it right after the change it stands for is visible (the awaited core call resolved, or the event arrived). */
  function bump(host: HostServices, owner: UserId): void {
    const rev = (need().revs.get(owner) ?? 0) + 1;
    need().revs.set(owner, rev);
    // Best effort: the in-memory value is right; a failed write is logged and the next bump rewrites it.
    host.store.set(REV_PREFIX + owner, rev).catch((err: unknown) => host.log.error('notifications: saving the revision failed', { err: String(err) }));
  }

  /** Pages through the user's unread notifications (newest first) with `before` until a short page; `visit` returns true to stop. */
  async function eachUnread(
    service: Service,
    owner: UserId,
    moduleId: string | undefined,
    visit: (n: NotificationRecord) => boolean | void,
  ): Promise<void> {
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = await service.list(owner, { limit: LIST_MAX, unreadOnly: true, ...(moduleId === undefined ? {} : { moduleId }), ...(before === undefined ? {} : { before }) });
      for (const n of items) if (visit(n)) return;
      const tail = items.at(-1);
      if (items.length < LIST_MAX || !tail) return;
      before = tail.createdAt;
    }
  }

  /**
   * The unread count without muted modules, and the newest unread notifications of modules that are not muted.
   * The stamp is read before the first await, so content may be newer than its rev, never older.
   * A muted module's notifications created while it was muted are stored already read, so only those that
   * existed before the mute need subtracting; they and the latest list are paged until a short page.
   */
  async function buildSnapshot(host: HostServices, owner: UserId): Promise<Snapshot> {
    const { epoch, rev } = stampOf(owner);
    const service = serviceOf(host);
    const muted = Object.keys(await service.getMutes(owner));
    let unread = await service.unreadCount(owner);
    for (const moduleId of muted) {
      await eachUnread(service, owner, moduleId, () => {
        unread -= 1;
      });
    }
    const latest: Snapshot['latest'] = [];
    await eachUnread(service, owner, undefined, (n) => {
      if (muted.includes(n.moduleId)) return;
      latest.push({ id: n.id, level: n.level, title: n.title, moduleId: n.moduleId, createdAt: n.createdAt });
      return latest.length >= LATEST;
    });
    return { epoch, rev, unread: Math.max(0, unread), latest };
  }

  const hasInstance = async (host: HostServices, owner: UserId): Promise<boolean> => (await host.instances()).some((i) => i.ownerId === owner);

  /** Builds the user's snapshot and pushes it to each of their instances (only when it changed). */
  async function pushFor(host: HostServices, owner: UserId): Promise<Snapshot> {
    const snapshot = await buildSnapshot(host, owner);
    // Instances are read after the build, then the pushes follow without another await: a removed instance is not pushed to.
    for (const instance of (await host.instances()).filter((i) => i.ownerId === owner)) need().pusher.push(instance.id, snapshot);
    return snapshot;
  }

  return defineServer({
    manifest,

    async setup(host) {
      const revs = new Map<UserId, number>();
      const owners = new Set((await host.instances()).map((i) => i.ownerId));
      for (const key of await host.store.keys(REV_PREFIX)) {
        const owner = key.slice(REV_PREFIX.length);
        const rev = await host.store.get<number>(key);
        if (!owners.has(owner)) await host.store.delete(key);
        else if (typeof rev === 'number') revs.set(owner, rev);
      }
      state = { pusher: createSnapshotPusher(host), epoch: newId(host.now()), revs };
    },

    on: {
      // Core publishes this only for notifications that were not muted, and only to the user it concerns.
      'notification.created': async (event, host) => {
        if (!host.notifications) {
          host.log.warn('notifications: the privileged service is missing, snapshots are not updated');
          return;
        }
        if (!(await hasInstance(host, event.userId))) return; // nobody to show it to: no rev, no snapshot
        bump(host, event.userId);
        await pushFor(host, event.userId);
      },
    },

    onInstanceChange: async (kind, instance, host) => {
      if (kind === 'removed') {
        need().pusher.forget(instance.id);
        if (!(await host.instances()).some((i) => i.ownerId === instance.ownerId && i.id !== instance.id)) {
          need().revs.delete(instance.ownerId);
          await host.store.delete(REV_PREFIX + instance.ownerId);
        }
      } else if (host.notifications) {
        await pushFor(host, instance.ownerId);
      }
    },

    routes(r, host) {
      // History, newest first, 50 per page. `next` is the `before` cursor for the following page.
      r.get('/list', { level: 'view', query: ListQuery }, async (req): Promise<ListPage> => {
        const { epoch, rev } = stampOf(req.user.id);
        const q = req.query;
        const items = await serviceOf(host).list(req.user.id, {
          limit: PAGE,
          ...(q.before === undefined ? {} : { before: q.before }),
          ...(q.unreadOnly === 'true' ? { unreadOnly: true } : {}),
          ...(q.moduleId === undefined ? {} : { moduleId: q.moduleId }),
        });
        return { epoch, rev, items, next: items.length === PAGE ? (items[PAGE - 1]?.createdAt ?? null) : null };
      });

      // Reading is the user's own state, so level `view` may do it (listed in the suite's viewWrites).
      r.post('/read', { level: 'view', body: ReadBody }, async (req): Promise<ReadResult> => {
        const mine = await hasInstance(host, req.user.id);
        await serviceOf(host).markRead(req.user.id, req.body.ids);
        if (mine) bump(host, req.user.id); // right after the change is visible
        const snapshot = mine ? await pushFor(host, req.user.id) : await buildSnapshot(host, req.user.id);
        return { epoch: snapshot.epoch, rev: snapshot.rev, unread: snapshot.unread };
      });

      r.get('/mutes', { level: 'view' }, async (req): Promise<MutesState> => {
        const { epoch, rev } = stampOf(req.user.id);
        return { epoch, rev, mutes: await serviceOf(host).getMutes(req.user.id) };
      });

      r.put('/mutes', { level: 'view', body: MuteBody }, async (req): Promise<MutesState> => {
        const { moduleId, hours } = req.body;
        // The end time comes from the server clock and is normalised to ISO.
        const until = hours === null ? null : hours === 'forever' ? 'forever' : new Date(host.now().getTime() + hours * 3_600_000).toISOString();
        const mine = await hasInstance(host, req.user.id);
        const service = serviceOf(host);
        await service.setMute(req.user.id, moduleId, until);
        if (mine) {
          bump(host, req.user.id);
          await pushFor(host, req.user.id);
        }
        const { epoch, rev } = stampOf(req.user.id);
        return { epoch, rev, mutes: await service.getMutes(req.user.id) };
      });
    },
  });
}

export default createNotificationsServer();
