// Pages: /api/pages and the layout PUT. Instances live in instances.ts.
import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DashError, PageDto, type UserId } from '@dash/contract';
import type { SessionUser } from '../seams.js';
import { parseWith, secured } from './csrf.js';
import { uuidv7 } from './ids.js';
import {
  accessPage,
  clampLayout,
  instanceDto,
  isAvailable,
  moduleOf,
  notifyInstanceChange,
  pageAudience,
  sendLayout,
  type CoreRouteDeps,
  type InstanceRow,
  type PageRow,
} from './instances.js';

/** Creates the "Today" page when the user has none. The auth track calls this when it creates a user. */
export function ensureStarterPage(db: BetterSqlite3.Database, userId: UserId, now: () => Date): string | undefined {
  const has = db.prepare('SELECT 1 FROM pages WHERE owner_id = ?').get(userId);
  if (has) return undefined;
  const id = uuidv7(now());
  db.prepare('INSERT INTO pages (id, owner_id, name, sort, shared) VALUES (?, ?, ?, 0, 0)').run(id, userId, 'Today');
  return id;
}

const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(40).nullable().optional(),
  shared: z.boolean().optional(),
  background: z.string().max(200).nullable().optional(),
});
const PatchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  icon: z.string().max(40).nullable().optional(),
  shared: z.boolean().optional(),
  background: z.string().max(200).nullable().optional(),
  order: z.number().int().optional(),
});
const LayoutBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        layout: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }),
        mobileOrder: z.number().int(),
      }),
    )
    .max(500),
});

export function registerPageRoutes(app: FastifyInstance, deps: CoreRouteDeps): void {
  const { db, auth } = deps;

  /** Instances the user may see on this page: module enabled/loaded and level != none. */
  const visibleInstances = (user: SessionUser, pageId: string): InstanceRow[] =>
    (db.prepare('SELECT * FROM instances WHERE page_id = ? ORDER BY mobile_order, id').all(pageId) as InstanceRow[]).filter(
      (r) => isAvailable(moduleOf(deps, r.module_id)) && auth.levelFor(user.id, r.module_id) !== 'none',
    );

  const dto = (user: SessionUser, p: PageRow): z.infer<typeof PageDto> =>
    PageDto.parse({
      id: p.id,
      name: p.name,
      icon: p.icon,
      order: p.sort,
      ownerId: p.owner_id,
      shared: p.shared === 1,
      background: p.background,
      instances: visibleInstances(user, p.id).map(instanceDto),
    });

  secured(app, auth, 'GET', '/api/pages', (user) => {
    ensureStarterPage(db, user.id, deps.now);
    const rows = db.prepare('SELECT * FROM pages WHERE owner_id = ? OR shared = 1 ORDER BY sort, id').all(user.id) as PageRow[];
    return rows.map((p) => dto(user, p));
  });

  secured(app, auth, 'POST', '/api/pages', (user, req) => {
    const body = parseWith(CreateBody, req.body);
    const next = (db.prepare('SELECT COALESCE(MAX(sort) + 1, 0) FROM pages WHERE owner_id = ?').pluck().get(user.id) as number);
    const page: PageRow = {
      id: uuidv7(deps.now()),
      owner_id: user.id,
      name: body.name,
      icon: body.icon ?? null,
      sort: next,
      shared: body.shared ? 1 : 0,
      background: body.background ?? null,
    };
    db.prepare('INSERT INTO pages (id, owner_id, name, icon, sort, shared, background) VALUES (?,?,?,?,?,?,?)').run(
      page.id, page.owner_id, page.name, page.icon, page.sort, page.shared, page.background,
    );
    sendLayout(deps, page);
    return dto(user, page);
  });

  secured(app, auth, 'PATCH', '/api/pages/:id', (user, req) => {
    const body = parseWith(PatchBody, req.body);
    const before = accessPage(db, user, (req.params as { id: string }).id, true);
    const after: PageRow = {
      ...before,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      ...(body.background !== undefined ? { background: body.background } : {}),
      ...(body.shared !== undefined ? { shared: body.shared ? 1 : 0 } : {}),
      ...(body.order !== undefined ? { sort: body.order } : {}),
    };
    db.prepare('UPDATE pages SET name=?, icon=?, sort=?, shared=?, background=? WHERE id=?').run(
      after.name, after.icon, after.sort, after.shared, after.background, after.id,
    );
    // Whoever could see the page before or after the change learns about it.
    for (const uid of new Set([...pageAudience(deps, before), ...pageAudience(deps, after)])) {
      deps.stream.sendToUser(uid, { type: 'layout', pageId: after.id });
    }
    return dto(user, after);
  });

  secured(app, auth, 'DELETE', '/api/pages/:id', async (user, req) => {
    const page = accessPage(db, user, (req.params as { id: string }).id, true);
    const count = db.prepare('SELECT COUNT(*) FROM pages WHERE owner_id = ?').pluck().get(user.id) as number;
    if (count <= 1) throw new DashError('conflict', 'The last page cannot be deleted');
    const rows = db.prepare('SELECT * FROM instances WHERE page_id = ?').all(page.id) as InstanceRow[];
    const audience = pageAudience(deps, page);
    db.transaction(() => {
      for (const r of rows) db.prepare('DELETE FROM snapshots WHERE instance_id = ?').run(r.id);
      db.prepare('DELETE FROM instances WHERE page_id = ?').run(page.id);
      db.prepare('DELETE FROM pages WHERE id = ?').run(page.id);
    })();
    for (const r of rows) {
      const mod = moduleOf(deps, r.module_id);
      await notifyInstanceChange(deps, mod, 'removed', {
        id: r.id, ownerId: page.owner_id, pageId: page.id, settings: JSON.parse(r.settings) as unknown,
      });
    }
    for (const id of new Set(rows.map((r) => r.module_id))) deps.scheduler.syncInstances(id);
    for (const uid of audience) deps.stream.sendToUser(uid, { type: 'layout', pageId: page.id });
    return undefined;
  });

  secured(app, auth, 'PUT', '/api/pages/:id/layout', (user, req) => {
    const body = parseWith(LayoutBody, req.body);
    const page = accessPage(db, user, (req.params as { id: string }).id, true);
    const own = new Map(
      (db.prepare('SELECT * FROM instances WHERE page_id = ?').all(page.id) as InstanceRow[]).map((r) => [r.id, r]),
    );
    const update = db.prepare('UPDATE instances SET x=?, y=?, w=?, h=?, mobile_order=? WHERE id=?');
    db.transaction(() => {
      for (const item of body.items) {
        const row = own.get(item.id);
        const mod = row ? moduleOf(deps, row.module_id) : undefined;
        if (!row || !mod || mod.failed !== undefined) continue; // foreign or unknown ids are ignored
        const l = clampLayout(item.layout, mod.server.manifest.tile);
        update.run(l.x, l.y, l.w, l.h, item.mobileOrder, row.id);
      }
    })();
    sendLayout(deps, page);
    return undefined;
  });
}
