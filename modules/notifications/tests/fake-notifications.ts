import type { HostServices, NotificationRecord } from '@dash/contract';
import type { MockHost } from '@dash/module-kit/testing';
import server from '../server/index.js';

type Service = NonNullable<HostServices['notifications']>;
type Row = NotificationRecord & { userId: string };

export interface FakeNotifications {
  api: Service;
  /**
   * Behaves like core's `notify`: stores the notification for the user; a muted module's notification is stored
   * already read and publishes no event; otherwise `notification.created` reaches the module's handler.
   */
  create(
    userId: string,
    moduleId: string,
    level: 'info' | 'warn' | 'critical',
    title: string,
    opts?: Partial<Pick<NotificationRecord, 'titleKey' | 'vars' | 'url' | 'body'>>,
  ): Promise<NotificationRecord>;
  rows: Row[];
}

/** An in-memory stand-in for the privileged `host.notifications` service, with the semantics of apps/server/src/core/notifications.ts. */
export function installFakeNotifications(host: MockHost): FakeNotifications {
  const rows: Row[] = [];
  const mutes = new Map<string, string>(); // `${userId}|${moduleId}` -> until
  let seq = 0;
  const iso = (): string => host.now().toISOString();
  const activeMute = (userId: string, moduleId: string): boolean => {
    const until = mutes.get(`${userId}|${moduleId}`);
    return until !== undefined && (until === 'forever' || until > iso());
  };
  const strip = (r: Row): NotificationRecord => ({
    id: r.id, moduleId: r.moduleId, level: r.level, title: r.title, body: r.body, titleKey: r.titleKey, bodyKey: r.bodyKey,
    vars: r.vars, url: r.url, createdAt: r.createdAt, readAt: r.readAt,
  });

  const api: Service = {
    list(userId, opts) {
      let found = rows.filter((r) => r.userId === userId);
      if (opts.before !== undefined) found = found.filter((r) => r.createdAt < opts.before!);
      if (opts.unreadOnly) found = found.filter((r) => r.readAt === null);
      if (opts.moduleId !== undefined) found = found.filter((r) => r.moduleId === opts.moduleId);
      found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return Promise.resolve(found.slice(0, Math.min(100, Math.max(1, Math.trunc(opts.limit)))).map(strip));
    },
    markRead(userId, ids) {
      for (const r of rows) {
        if (r.userId === userId && r.readAt === null && (ids === 'all' || ids.includes(r.id))) r.readAt = iso();
      }
      return Promise.resolve();
    },
    unreadCount: (userId) => Promise.resolve(rows.filter((r) => r.userId === userId && r.readAt === null).length),
    getMutes(userId) {
      const out: Record<string, string> = {};
      for (const [key, until] of mutes) {
        const [u, moduleId] = key.split('|') as [string, string];
        if (u === userId && activeMute(u, moduleId)) out[moduleId] = until;
      }
      return Promise.resolve(out);
    },
    setMute(userId, moduleId, until) {
      if (until === null) mutes.delete(`${userId}|${moduleId}`);
      else mutes.set(`${userId}|${moduleId}`, until);
      return Promise.resolve();
    },
  };

  host.notifications = api;

  return {
    api,
    rows,
    async create(userId, moduleId, level, title, opts = {}) {
      const muted = activeMute(userId, moduleId);
      const createdAt = iso();
      const row: Row = {
        id: `n${String(++seq).padStart(4, '0')}`,
        userId,
        moduleId,
        level,
        title,
        body: opts.body ?? null,
        titleKey: opts.titleKey ?? null,
        bodyKey: null,
        vars: opts.vars ?? null,
        url: opts.url ?? null,
        createdAt,
        readAt: muted ? createdAt : null,
      };
      rows.push(row);
      if (!muted) await server.on!['notification.created']!({ id: row.id, userId, moduleId, level, title, createdAt }, host);
      return strip(row);
    },
  };
}
