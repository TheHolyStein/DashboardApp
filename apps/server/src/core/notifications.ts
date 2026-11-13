// Notification service (host.notify + the privileged host.notifications API) and /api/notifications.
import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NotificationDto,
  type HostServices,
  type ModuleId,
  type Notification,
  type NotificationRecord,
  type UserId,
} from '@dash/contract';
import type { AuthSeam } from '../seams.js';
import { parseWith, secured } from './csrf.js';
import { uuidv7 } from './ids.js';
import type { Bus, LoggerLike, NotificationsDep, Stream } from './modules/deps.js';

/** Module ids that get the privileged `host.notifications` service. */
export const PRIVILEGED: Record<string, string[]> = { notifications: ['notifications'] };

export const TITLE_MAX = 200;
export const BODY_MAX = 2000;
export const DEDUPE_WINDOW_MS = 24 * 3600 * 1000;
export const RETENTION_MS = 30 * 24 * 3600 * 1000;

export type NotificationData = z.infer<typeof NotificationDto>;
/** Called for every stored, unmuted notification (Web Push attaches here). Errors are logged and isolated. */
export type NotificationSink = (e: { userId: UserId; notification: NotificationData }) => void | Promise<void>;

export interface NotificationsService extends NotificationsDep {
  registerNotificationSink(fn: NotificationSink): void;
  /** The privileged API; also what the REST routes use. */
  api: NonNullable<HostServices['notifications']>;
}

export interface NotificationsDeps {
  db: BetterSqlite3.Database;
  auth: Pick<AuthSeam, 'listUsers' | 'levelFor'>;
  bus: Pick<Bus, 'publish'>;
  stream: Pick<Stream, 'sendToUser'>;
  now: () => Date;
  logger: LoggerLike;
}

interface Row {
  id: string; module_id: string; level: string; title: string; body: string | null; url: string | null;
  created_at: string; read_at: string | null;
}

const toRecord = (r: Row): NotificationRecord => ({
  id: r.id,
  moduleId: r.module_id,
  level: r.level as NotificationRecord['level'],
  title: r.title,
  body: r.body,
  url: r.url,
  createdAt: r.created_at,
  readAt: r.read_at,
});

/** Only relative in-dashboard paths: starts with "/", not "//" or "/\", no control characters. */
export function safeUrl(url: string | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(url) ? null : url;
}

export function createNotifications(deps: NotificationsDeps): NotificationsService {
  const { db, auth, logger } = deps;
  const sinks: NotificationSink[] = [];
  const iso = (offsetMs = 0): string => new Date(deps.now().getTime() + offsetMs).toISOString();

  const muteUntil = db.prepare('SELECT until FROM notification_mutes WHERE user_id = ? AND module_id = ?').pluck();
  const isMuted = (userId: UserId, moduleId: ModuleId): boolean => {
    const until = muteUntil.get(userId, moduleId) as string | undefined;
    return until !== undefined && (until === 'forever' || until > iso());
  };

  const findDedupe = db.prepare(
    `SELECT id FROM notifications WHERE module_id = ? AND dedupe_key = ? AND user_id = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`,
  );
  const update = db.prepare(
    'UPDATE notifications SET level=?, title=?, body=?, url=?, created_at=?, read_at=? WHERE id=?',
  );
  const insert = db.prepare(
    `INSERT INTO notifications (id, module_id, user_id, level, title, body, url, dedupe_key, created_at, read_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );

  function targets(moduleId: ModuleId, n: Notification): UserId[] {
    const known = auth.listUsers().map((u) => u.id);
    const wanted = n.userIds ? known.filter((id) => n.userIds?.includes(id)) : known;
    return wanted.filter((id) => auth.levelFor(id, moduleId) !== 'none');
  }

  function notify(moduleId: ModuleId, n: Notification): void {
    const level = n.level === 'warn' || n.level === 'critical' ? n.level : 'info';
    const title = String(n.title).slice(0, TITLE_MAX);
    const body = n.body === undefined ? null : String(n.body).slice(0, BODY_MAX);
    const url = safeUrl(n.url);
    const stored: Array<{ userId: UserId; dto: NotificationData }> = [];

    db.transaction(() => {
      for (const userId of targets(moduleId, n)) {
        const muted = isMuted(userId, moduleId);
        const createdAt = iso();
        const readAt = muted ? createdAt : null;
        const existing =
          n.dedupeKey === undefined
            ? undefined
            : (findDedupe.get(moduleId, n.dedupeKey, userId, iso(-DEDUPE_WINDOW_MS)) as { id: string } | undefined);
        const id = existing?.id ?? uuidv7(deps.now());
        if (existing) update.run(level, title, body, url, createdAt, readAt, id);
        else insert.run(id, moduleId, userId, level, title, body, url, n.dedupeKey ?? null, createdAt, readAt);
        if (!muted) {
          stored.push({
            userId,
            dto: NotificationDto.parse({ id, moduleId, level, title, body, url, createdAt, readAt: null }),
          });
        }
      }
    })();

    for (const { userId, dto } of stored) {
      deps.stream.sendToUser(userId, { type: 'notification', notification: dto });
      deps.bus.publish('core', 'notification.created', {
        id: dto.id, userId, moduleId, level: dto.level, title: dto.title, createdAt: dto.createdAt,
      });
      for (const sink of sinks) {
        try {
          void Promise.resolve(sink({ userId, notification: dto })).catch((err: unknown) => sinkFailed(err));
        } catch (err) {
          sinkFailed(err);
        }
      }
    }
  }

  function sinkFailed(err: unknown): void {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'notification sink failed');
  }

  const api: NonNullable<HostServices['notifications']> = {
    list(userId, opts) {
      const where = ['user_id = ?'];
      const params: unknown[] = [userId];
      if (opts.before !== undefined) { where.push('created_at < ?'); params.push(opts.before); }
      if (opts.unreadOnly) where.push('read_at IS NULL');
      if (opts.moduleId !== undefined) { where.push('module_id = ?'); params.push(opts.moduleId); }
      const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit)));
      const rows = db
        .prepare(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...params, limit) as Row[];
      return Promise.resolve(rows.map(toRecord));
    },
    markRead(userId, ids) {
      const at = iso();
      if (ids === 'all') {
        db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId);
      } else if (ids.length > 0) {
        const marks = ids.map(() => '?').join(',');
        db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${marks})`).run(
          at, userId, ...ids,
        );
      }
      return Promise.resolve();
    },
    unreadCount: (userId) =>
      Promise.resolve(
        db.prepare('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL').pluck().get(userId) as number,
      ),
    getMutes(userId) {
      const rows = db.prepare('SELECT module_id, until FROM notification_mutes WHERE user_id = ?').all(userId) as Array<{
        module_id: string; until: string;
      }>;
      const now = iso();
      return Promise.resolve(
        Object.fromEntries(rows.filter((r) => r.until === 'forever' || r.until > now).map((r) => [r.module_id, r.until])),
      );
    },
    setMute(userId, moduleId, until) {
      if (until === null) {
        db.prepare('DELETE FROM notification_mutes WHERE user_id = ? AND module_id = ?').run(userId, moduleId);
      } else {
        db.prepare(
          `INSERT INTO notification_mutes (user_id, module_id, until) VALUES (?,?,?)
           ON CONFLICT(user_id, module_id) DO UPDATE SET until = excluded.until`,
        ).run(userId, moduleId, until);
      }
      return Promise.resolve();
    },
  };

  return {
    notify,
    privileged: (moduleId) => (PRIVILEGED['notifications']?.includes(moduleId) ? api : undefined),
    registerNotificationSink: (fn) => void sinks.push(fn),
    api,
  };
}

/** Deletes notifications older than 30 days; returns how many. Scheduled daily by a later task. */
export function purgeOldNotifications(db: BetterSqlite3.Database, now: Date): number {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  return db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff).changes;
}

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().max(40).optional(),
  unreadOnly: z.enum(['true', 'false', '1', '0']).optional(),
});
const ReadBody = z.object({ ids: z.union([z.literal('all'), z.array(z.string()).max(500)]) });

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: { auth: AuthSeam; notifications: Pick<NotificationsService, 'api'> },
): void {
  const { auth } = deps;
  const { api } = deps.notifications;

  secured(app, auth, 'GET', '/api/notifications', async (user, req) => {
    const q = parseWith(ListQuery, req.query, 'query');
    const rows = await api.list(user.id, {
      limit: q.limit,
      ...(q.before === undefined ? {} : { before: q.before }),
      unreadOnly: q.unreadOnly === 'true' || q.unreadOnly === '1',
    });
    return rows.map((r) => NotificationDto.parse(r));
  });

  secured(app, auth, 'POST', '/api/notifications/read', async (user, req) => {
    await api.markRead(user.id, parseWith(ReadBody, req.body).ids);
    return undefined;
  });
}
