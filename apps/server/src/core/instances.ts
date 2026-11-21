// Module instances (tiles on pages): storage helpers, layout rules, the sync reader for the scheduler,
// ModuleStateDep, and the /api/instances routes.
import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DashError,
  GRID_COLUMNS,
  InstanceDto,
  type ModuleId,
  type ModuleInstance,
  type TileSize,
} from '@dash/contract';
import type { AuthSeam, SessionUser } from '../seams.js';
import { parseWith, secured } from './csrf.js';
import { uuidv7 } from './ids.js';
import type { LoadedModule, LoggerLike, ModuleStateDep, Scheduler, Stream } from './modules/deps.js';
import type { Snapshots } from './snapshots.js';

export interface Layout { x: number; y: number; w: number; h: number }

/** Dependencies shared by the page, instance and admin route groups. */
export interface CoreRouteDeps {
  db: BetterSqlite3.Database;
  auth: AuthSeam;
  /** The loader's array; `enabled`/`failed` are read live. */
  modules: LoadedModule[];
  scheduler: Pick<Scheduler, 'syncInstances'>;
  stream: Pick<Stream, 'sendToUser' | 'sendSnapshot'>;
  /** Optional: when given, a newly placed instance gets its current snapshot pushed. */
  snapshots?: Pick<Snapshots, 'forInstance'>;
  now: () => Date;
  logger: LoggerLike;
}

export interface PageRow { id: string; owner_id: string; name: string; icon: string | null; sort: number; shared: number; background: string | null }
export interface InstanceRow {
  id: string; module_id: string; page_id: string; settings: string;
  x: number; y: number; w: number; h: number; mobile_order: number;
}

export function pageRow(db: BetterSqlite3.Database, id: string): PageRow | undefined {
  return db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as PageRow | undefined;
}

/** 404 when the page does not exist or is neither owned by nor shared with the user; 403 when visible but not owned and `owner` is required. */
export function accessPage(db: BetterSqlite3.Database, user: SessionUser, pageId: string, owner: boolean): PageRow {
  const page = pageRow(db, pageId);
  if (!page || (page.owner_id !== user.id && page.shared !== 1)) throw new DashError('not_found', 'Page not found');
  if (owner && page.owner_id !== user.id) throw new DashError('forbidden', 'Only the owner can change this page');
  return page;
}

export function instanceDto(row: InstanceRow): z.infer<typeof InstanceDto> {
  return InstanceDto.parse({
    id: row.id,
    moduleId: row.module_id,
    pageId: row.page_id,
    settings: JSON.parse(row.settings) as unknown,
    layout: { x: row.x, y: row.y, w: row.w, h: row.h },
    mobileOrder: row.mobile_order,
  });
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** w/h to the tile's min..max (and w to the grid), x so that x + w fits the grid, x/y >= 0. */
export function clampLayout(l: Layout, tile: { min: TileSize; max: TileSize }): Layout {
  const w = clamp(l.w, tile.min.w, Math.min(tile.max.w, GRID_COLUMNS));
  const h = clamp(l.h, tile.min.h, tile.max.h);
  return { x: clamp(l.x, 0, GRID_COLUMNS - w), y: Math.max(0, l.y), w, h };
}

/** First slot (row-major) where a w x h tile fits without overlapping `taken`. */
export function firstFreeSlot(taken: Layout[], w: number, h: number): { x: number; y: number } {
  const overlaps = (x: number, y: number): boolean =>
    taken.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h);
  const bottom = taken.reduce((m, t) => Math.max(m, t.y + t.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) if (!overlaps(x, y)) return { x, y };
  }
  return { x: 0, y: bottom };
}

/** Users who see a page: its owner, plus everyone when it is shared. */
export function pageAudience(deps: Pick<CoreRouteDeps, 'auth'>, page: Pick<PageRow, 'owner_id' | 'shared'>): string[] {
  return page.shared === 1
    ? [...new Set([page.owner_id, ...deps.auth.listUsers().map((u) => u.id)])]
    : [page.owner_id];
}

export function moduleOf(deps: Pick<CoreRouteDeps, 'modules'>, id: ModuleId): LoadedModule | undefined {
  return deps.modules.find((m) => m.id === id);
}

export const isAvailable = (m: LoadedModule | undefined): m is LoadedModule => m !== undefined && m.failed === undefined && m.enabled && m.setupRan;

// ---- providers for the scheduler and host -------------------------------------------------------------

/** Synchronous reader for `createScheduler({ instances })`: every placed instance of a module, read live. */
export function createInstanceReader(db: BetterSqlite3.Database): (moduleId: ModuleId) => ModuleInstance[] {
  const stmt = db.prepare(
    `SELECT i.id AS id, i.page_id AS pageId, i.settings AS settings, p.owner_id AS ownerId
     FROM instances i JOIN pages p ON p.id = i.page_id WHERE i.module_id = ? ORDER BY i.id`,
  );
  return (moduleId) =>
    (stmt.all(moduleId) as Array<{ id: string; pageId: string; settings: string; ownerId: string }>).map((r) => ({
      id: r.id,
      ownerId: r.ownerId,
      pageId: r.pageId,
      settings: JSON.parse(r.settings) as unknown,
    }));
}

/** `ModuleStateDep` for `createHost`: stored admin config (`module_state.config`) and placed instances. */
export function createModuleState(db: BetterSqlite3.Database): ModuleStateDep {
  const read = createInstanceReader(db);
  const cfg = db.prepare('SELECT config FROM module_state WHERE module_id = ?').pluck();
  return {
    config: (moduleId) => {
      const raw = cfg.get(moduleId) as string | undefined;
      return Promise.resolve(raw === undefined ? undefined : (JSON.parse(raw) as unknown));
    },
    instances: (moduleId) => Promise.resolve(read(moduleId)),
  };
}

// ---- after-change plumbing ----------------------------------------------------------------------------

/** Runs the module's `onInstanceChange` (errors logged, never thrown). */
export async function notifyInstanceChange(
  deps: Pick<CoreRouteDeps, 'logger'>,
  mod: LoadedModule | undefined,
  kind: 'added' | 'updated' | 'removed',
  instance: ModuleInstance,
): Promise<void> {
  if (!mod || mod.failed !== undefined || !mod.enabled || !mod.setupRan || !mod.server.onInstanceChange) return;
  try {
    await mod.server.onInstanceChange(kind, instance, mod.host);
  } catch (err) {
    deps.logger.error({ module: mod.id, kind, err: err instanceof Error ? err.message : String(err) }, 'onInstanceChange failed');
  }
}

export function sendLayout(deps: Pick<CoreRouteDeps, 'stream' | 'auth'>, page: Pick<PageRow, 'id' | 'owner_id' | 'shared'>): void {
  for (const uid of pageAudience(deps, page)) deps.stream.sendToUser(uid, { type: 'layout', pageId: page.id });
}

const PartialLayout = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  w: z.number().int().optional(),
  h: z.number().int().optional(),
});

const CreateBody = z.object({
  moduleId: z.string(),
  pageId: z.string(),
  settings: z.unknown().optional(),
  layout: PartialLayout.optional(),
});
const PatchBody = z.object({
  settings: z.unknown().optional(),
  layout: PartialLayout.optional(),
  mobileOrder: z.number().int().optional(),
});

function toModuleInstance(row: InstanceRow, ownerId: string): ModuleInstance {
  return { id: row.id, ownerId, pageId: row.page_id, settings: JSON.parse(row.settings) as unknown };
}

/**
 * `POST /api/instances`, `PATCH|DELETE /api/instances/:id`. Creating needs page ownership, level >= view on the
 * module, and the module loaded and enabled (else 404, same as the module router). Patching needs ownership and a
 * grant; deleting needs only ownership (so a revoked or disabled module's tiles can still be cleaned up).
 */
export function registerInstanceRoutes(app: FastifyInstance, deps: CoreRouteDeps): void {
  const { db, auth } = deps;

  const siblings = (pageId: string, exceptId?: string): InstanceRow[] =>
    (db.prepare('SELECT * FROM instances WHERE page_id = ?').all(pageId) as InstanceRow[]).filter((r) => r.id !== exceptId);

  const finish = async (kind: 'added' | 'updated' | 'removed', page: PageRow, row: InstanceRow): Promise<void> => {
    const mod = moduleOf(deps, row.module_id);
    await notifyInstanceChange(deps, mod, kind, toModuleInstance(row, page.owner_id));
    if (mod) deps.scheduler.syncInstances(mod.id);
    sendLayout({ stream: deps.stream, auth }, page);
    if (kind === 'added' && deps.snapshots) {
      const snap = deps.snapshots.forInstance(row.module_id, row.id);
      if (snap) deps.stream.sendSnapshot(row.module_id, row.id, snap);
    }
  };

  secured(app, auth, 'POST', '/api/instances', async (user, req) => {
    const body = parseWith(CreateBody, req.body);
    const page = accessPage(db, user, body.pageId, true);
    const mod = moduleOf(deps, body.moduleId);
    if (!isAvailable(mod)) throw new DashError('not_found', 'Module not found');
    if (auth.levelFor(user.id, mod.id) === 'none') throw new DashError('forbidden', 'No access to this module');
    const m = mod.server.manifest;
    const settings = parseWith(m.settings, body.settings ?? {}, 'settings');
    if (!m.multiInstance) {
      const has = db
        .prepare('SELECT 1 FROM instances i JOIN pages p ON p.id = i.page_id WHERE p.owner_id = ? AND i.module_id = ?')
        .get(user.id, mod.id);
      if (has) throw new DashError('conflict', 'This module allows only one instance per user');
    }
    const existing = siblings(page.id);
    const size = clampLayout(
      { x: 0, y: 0, w: body.layout?.w ?? m.tile.default.w, h: body.layout?.h ?? m.tile.default.h },
      m.tile,
    );
    const free = firstFreeSlot(existing, size.w, size.h);
    const layout = clampLayout({ ...size, x: body.layout?.x ?? free.x, y: body.layout?.y ?? free.y }, m.tile);
    const row: InstanceRow = {
      id: uuidv7(deps.now()),
      module_id: mod.id,
      page_id: page.id,
      settings: JSON.stringify(settings),
      ...layout,
      mobile_order: existing.reduce((mx, r) => Math.max(mx, r.mobile_order + 1), 0),
    };
    db.prepare(
      'INSERT INTO instances (id, module_id, page_id, settings, x, y, w, h, mobile_order) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(row.id, row.module_id, row.page_id, row.settings, row.x, row.y, row.w, row.h, row.mobile_order);
    await finish('added', page, row);
    return instanceDto(row);
  });

  const loadOwned = (user: SessionUser, id: string): { row: InstanceRow; page: PageRow } => {
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as InstanceRow | undefined;
    if (!row) throw new DashError('not_found', 'Instance not found');
    return { row, page: accessPage(db, user, row.page_id, true) };
  };

  secured(app, auth, 'PATCH', '/api/instances/:id', async (user, req) => {
    const body = parseWith(PatchBody, req.body);
    const { row, page } = loadOwned(user, (req.params as { id: string }).id);
    if (auth.levelFor(user.id, row.module_id) === 'none') throw new DashError('forbidden', 'No access to this module');
    const mod = moduleOf(deps, row.module_id);
    if (!isAvailable(mod)) throw new DashError('not_found', 'Module not found');
    const m = mod.server.manifest;
    const next: InstanceRow = { ...row };
    if (body.settings !== undefined) next.settings = JSON.stringify(parseWith(m.settings, body.settings, 'settings'));
    if (body.layout) {
      const l = body.layout;
      Object.assign(next, clampLayout({ x: l.x ?? row.x, y: l.y ?? row.y, w: l.w ?? row.w, h: l.h ?? row.h }, m.tile));
    }
    if (body.mobileOrder !== undefined) next.mobile_order = body.mobileOrder;
    db.prepare('UPDATE instances SET settings=?, x=?, y=?, w=?, h=?, mobile_order=? WHERE id=?').run(
      next.settings, next.x, next.y, next.w, next.h, next.mobile_order, next.id,
    );
    await finish('updated', page, next);
    return instanceDto(next);
  });

  secured(app, auth, 'DELETE', '/api/instances/:id', async (user, req) => {
    const { row, page } = loadOwned(user, (req.params as { id: string }).id);
    db.transaction(() => {
      db.prepare('DELETE FROM snapshots WHERE instance_id = ?').run(row.id);
      db.prepare('DELETE FROM instances WHERE id = ?').run(row.id);
    })();
    await finish('removed', page, row);
    return undefined;
  });
}
