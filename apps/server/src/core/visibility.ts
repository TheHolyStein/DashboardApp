import type BetterSqlite3 from 'better-sqlite3';
import type { InstanceId, ModuleId, UserId } from '@dash/contract';
import type { VisibilityDep } from './modules/deps.js';

/**
 * Visibility straight from the `pages`/`instances` tables: a user sees the instances on their own pages
 * and on shared pages. `allUsers` supplies the audience of shared pages (normally `auth.listUsers`).
 * Not cached: every call reads the tables.
 */
export function createVisibility(db: BetterSqlite3.Database, allUsers: () => UserId[]): VisibilityDep {
  const visible = db.prepare(
    `SELECT i.id AS instanceId, i.module_id AS moduleId FROM instances i
     JOIN pages p ON p.id = i.page_id WHERE p.owner_id = ? OR p.shared = 1`,
  );
  const rows = db.prepare(
    `SELECT p.owner_id AS ownerId, p.shared AS shared FROM instances i
     JOIN pages p ON p.id = i.page_id WHERE i.module_id = ? AND (? IS NULL OR i.id = ?)`,
  );
  return {
    visibleInstances: (userId) => visible.all(userId) as Array<{ instanceId: InstanceId; moduleId: ModuleId }>,
    viewersOf(moduleId, instanceId) {
      const out = new Set<UserId>();
      for (const r of rows.all(moduleId, instanceId, instanceId) as Array<{ ownerId: string; shared: number }>) {
        if (r.shared === 1) return [...new Set(allUsers())];
        out.add(r.ownerId);
      }
      return [...out];
    },
  };
}
