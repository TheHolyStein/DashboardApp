import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DashError, type InstanceId, type ModuleId, type UserId } from '@dash/contract';
import type { AuthSeam } from '../seams.js';
import { csrfOk } from './csrf.js';
import type { LoggerLike, Scheduler, Stream, StreamEvent, VisibilityDep } from './modules/deps.js';
import type { Snapshots, StoredSnapshot } from './snapshots.js';

export const PING_INTERVAL_MS = 25_000;
export const MAX_STREAMS_PER_USER = 6;
export const MAX_QUEUED_BYTES = 1024 * 1024;
export const MAX_VIEW_IDS = 200;

export interface StreamTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StreamDeps {
  auth: AuthSeam;
  snapshots: Pick<Snapshots, 'forInstance' | 'toDto'>;
  visibility: VisibilityDep;
  now: () => Date;
  logger: LoggerLike;
  timers?: StreamTimers;
  /** Queued bytes per connection above which it is closed (default 1 MB). */
  maxQueuedBytes?: number;
}

export interface StreamService extends Stream {
  /** Instances the user may currently see AND has a grant for (what `POST /api/stream/view` accepts). */
  viewable(userId: UserId): InstanceId[];
  now(): Date;
  /** Closes every stream and clears all timers. */
  close(): void;
}

interface Conn {
  userId: UserId;
  out: PassThrough;
  /** Modules whose snapshots are withheld from this connection (revoked / disconnected). */
  muted: Set<ModuleId>;
  closed: boolean;
}

interface CoreValue {
  data: unknown;
  updatedAt: string;
  userIds: Set<UserId> | undefined;
}

export function createStream(deps: StreamDeps): StreamService {
  const { auth, visibility, snapshots, logger } = deps;
  const maxQueued = deps.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const timers: StreamTimers = deps.timers ?? {
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref();
      return h;
    },
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  };
  const conns = new Map<UserId, Conn[]>();
  const core = new Map<string, CoreValue>();
  let pingTimer: unknown;

  const allConns = (): Conn[] => [...conns.values()].flat();

  function stopTimerIfIdle(): void {
    if (pingTimer !== undefined && conns.size === 0) {
      timers.clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  function closeConn(c: Conn, abrupt = false): void {
    if (c.closed) return;
    c.closed = true;
    const list = (conns.get(c.userId) ?? []).filter((x) => x !== c);
    if (list.length > 0) conns.set(c.userId, list);
    else conns.delete(c.userId);
    if (abrupt) c.out.destroy();
    else c.out.end();
    stopTimerIfIdle();
  }

  function queued(c: Conn): number {
    return c.out.writableLength + c.out.readableLength;
  }

  function write(c: Conn, ev: StreamEvent): void {
    if (c.closed) return;
    c.out.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (queued(c) > maxQueued) {
      logger.warn({ user: c.userId }, 'stream closed: client is not draining');
      closeConn(c, true);
    }
  }

  const granted = (userId: UserId, moduleId: ModuleId): boolean => auth.levelFor(userId, moduleId) !== 'none';

  /** Current snapshots of the user's visible, granted instances (optionally of one module). */
  function currentFor(userId: UserId, moduleId?: ModuleId): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (const inst of visibility.visibleInstances(userId)) {
      if (moduleId !== undefined && inst.moduleId !== moduleId) continue;
      if (!granted(userId, inst.moduleId)) continue;
      const stored = snapshots.forInstance(inst.moduleId, inst.instanceId);
      if (stored) out.push({ type: 'snapshot', snapshot: snapshots.toDto(stored, inst.instanceId) });
    }
    return out;
  }

  function coreEvent(key: string, v: CoreValue): StreamEvent {
    return {
      type: 'snapshot',
      snapshot: { instanceId: `core:${key}`, data: v.data, updatedAt: v.updatedAt, stale: false },
    };
  }

  function sendSnapshot(moduleId: ModuleId, instanceId: InstanceId | null, snap: unknown): void {
    const stored = snap as StoredSnapshot;
    for (const userId of visibility.viewersOf(moduleId, instanceId)) {
      const list = conns.get(userId);
      if (!list || !granted(userId, moduleId)) continue;
      const events: StreamEvent[] = [];
      if (instanceId !== null) {
        events.push({ type: 'snapshot', snapshot: snapshots.toDto(stored, instanceId) });
      } else {
        for (const inst of visibility.visibleInstances(userId)) {
          if (inst.moduleId !== moduleId) continue;
          const own = snapshots.forInstance(moduleId, inst.instanceId) ?? stored;
          events.push({ type: 'snapshot', snapshot: snapshots.toDto(own, inst.instanceId) });
        }
      }
      for (const c of [...list]) {
        if (c.muted.has(moduleId)) continue;
        for (const ev of events) write(c, ev);
      }
    }
  }

  function sendToUser(userId: UserId, ev: StreamEvent): void {
    for (const c of [...(conns.get(userId) ?? [])]) write(c, ev);
  }

  function sendCore(key: string, data: unknown, userIds?: UserId[]): void {
    const v: CoreValue = { data, updatedAt: deps.now().toISOString(), userIds: userIds ? new Set(userIds) : undefined };
    core.set(key, v);
    const ev = coreEvent(key, v);
    for (const c of allConns()) {
      if (!v.userIds || v.userIds.has(c.userId)) write(c, ev);
    }
  }

  function disconnectUser(userId: UserId, moduleId?: ModuleId): void {
    const list = [...(conns.get(userId) ?? [])];
    if (moduleId === undefined) {
      for (const c of list) closeConn(c);
      return;
    }
    for (const c of list) {
      c.muted.add(moduleId);
      write(c, { type: 'revoked', moduleId });
    }
  }

  auth.onGrantsChanged((userId, moduleId, level) => {
    const list = [...(conns.get(userId) ?? [])];
    if (list.length === 0) return;
    if (level === 'none') {
      for (const c of list) {
        c.muted.add(moduleId);
        write(c, { type: 'revoked', moduleId });
      }
      return;
    }
    const events = currentFor(userId, moduleId);
    for (const c of list) {
      c.muted.delete(moduleId);
      for (const ev of events) write(c, ev);
    }
  });

  function handle(req: FastifyRequest, reply: FastifyReply): void {
    const user = auth.requireUser(req);
    const c: Conn = { userId: user.id, out: new PassThrough(), muted: new Set(), closed: false };
    const mine = [...(conns.get(user.id) ?? [])];
    while (mine.length >= MAX_STREAMS_PER_USER) {
      const oldest = mine.shift();
      if (oldest) closeConn(oldest);
    }
    mine.push(c);
    conns.set(user.id, mine);

    c.out.on('error', () => closeConn(c, true));
    req.raw.on('close', () => closeConn(c, true));

    void reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-store')
      .header('X-Accel-Buffering', 'no')
      .send(c.out);

    c.out.write(': connected\n\n');
    for (const ev of currentFor(user.id)) write(c, ev);
    for (const [key, v] of core) {
      if (!v.userIds || v.userIds.has(user.id)) write(c, coreEvent(key, v));
    }

    pingTimer ??= timers.setInterval(() => {
      const ev: StreamEvent = { type: 'ping', at: deps.now().toISOString() };
      for (const conn of allConns()) write(conn, ev);
    }, PING_INTERVAL_MS);
  }

  function viewable(userId: UserId): InstanceId[] {
    return visibility
      .visibleInstances(userId)
      .filter((i) => granted(userId, i.moduleId))
      .map((i) => i.instanceId);
  }

  function close(): void {
    for (const c of allConns()) closeConn(c);
    if (pingTimer !== undefined) {
      timers.clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  return { handle, sendSnapshot, sendToUser, sendCore, disconnectUser, viewable, now: deps.now, close };
}

export interface StreamRouteDeps {
  stream: StreamService;
  scheduler: Pick<Scheduler, 'markViewed'>;
  auth: AuthSeam;
}

/** `GET /api/stream` (SSE) and `POST /api/stream/view`; closes all streams when the app closes. */
export function registerStreamRoutes(app: FastifyInstance, deps: StreamRouteDeps): void {
  const { stream, scheduler, auth } = deps;

  app.get('/api/stream', (req, reply) => {
    stream.handle(req, reply);
    return reply;
  });

  app.post(
    '/api/stream/view',
    {
      schema: {
        body: {
          type: 'object',
          required: ['instanceIds'],
          additionalProperties: false,
          properties: {
            instanceIds: { type: 'array', maxItems: MAX_VIEW_IDS, items: { type: 'string', maxLength: 128 } },
          },
        },
      },
    },
    (req, reply) => {
      const user = auth.requireUser(req);
      if (!csrfOk(req)) throw new DashError('forbidden', 'CSRF token missing or invalid');
      const asked = (req.body as { instanceIds: string[] }).instanceIds;
      const allowed = new Set(stream.viewable(user.id));
      const ids = [...new Set(asked.filter((id) => allowed.has(id)))];
      if (ids.length > 0) scheduler.markViewed(ids, stream.now());
      return reply.code(204).send();
    },
  );

  // preClose runs before the server stops listening; ended streams would otherwise hold app.close() open
  app.addHook('preClose', () => {
    stream.close();
  });
}
