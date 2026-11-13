import type BetterSqlite3 from 'better-sqlite3';
import { validateManifest, type HostServices, type ModuleId, type ModuleServer } from '@dash/contract';
import { migrateModule } from '../migrate.js';
import type { LoadedModule, LoggerLike } from './deps.js';

export type { LoadedModule } from './deps.js';

/** Root path prefixes a module may mount outside /api/m/<id>. Exact, per module id. */
export const ROOT_MOUNT_ALLOW: Record<ModuleId, string[]> = { calendar: ['/dav', '/.well-known/caldav'] };

export interface LoaderDeps {
  logger: LoggerLike;
  /** Builds the module's host (normally `(s) => createHost(s.manifest.id, {...})`). Called after validation. */
  makeHost(server: ModuleServer): HostServices;
}

type Registry = ReadonlyArray<() => Promise<{ default: ModuleServer }>>;

function problemsOf(server: ModuleServer): string[] {
  const m = server.manifest;
  const problems = validateManifest(m);
  const declaredJobs = new Set(m.jobs.map((j) => j.name));
  const jobKeys = Object.keys(server.jobs ?? {});
  for (const name of declaredJobs) if (!jobKeys.includes(name)) problems.push(`manifest job "${name}" has no handler`);
  for (const key of jobKeys) if (!declaredJobs.has(key)) problems.push(`job handler "${key}" is not in manifest.jobs`);
  const subscribes: readonly string[] = m.subscribes;
  for (const key of Object.keys(server.on ?? {})) {
    if (!subscribes.includes(key)) problems.push(`handler for "${key}" is not in manifest.subscribes`);
  }
  const allowed = Object.hasOwn(ROOT_MOUNT_ALLOW, m.id) ? (ROOT_MOUNT_ALLOW[m.id] as string[]) : [];
  for (const mount of m.rootMounts ?? []) {
    if (!allowed.includes(mount.prefix)) problems.push(`rootMount "${mount.prefix}" is not allow-listed for module ${m.id}`);
  }
  return problems;
}

/**
 * Imports, validates and migrates every registered module. A module that fails any step is logged and
 * returned with `failed` set; the others still load. Never throws for a single module's fault.
 */
export async function loadModules(
  registry: Registry,
  db: BetterSqlite3.Database,
  deps: LoaderDeps,
): Promise<LoadedModule[]> {
  const out: LoadedModule[] = [];
  const seen = new Set<ModuleId>();
  const failedModule = (id: ModuleId, server: ModuleServer | undefined, reason: string): LoadedModule => {
    deps.logger.error({ module: id, reason }, 'module failed to load');
    return {
      id,
      server: server ?? ({ manifest: { id } } as ModuleServer),
      host: undefined as unknown as HostServices,
      enabled: false,
      failed: reason,
    };
  };

  for (const [index, load] of registry.entries()) {
    let server: ModuleServer | undefined;
    let id: ModuleId = `unknown-${index}`;
    try {
      server = (await load()).default;
      id = String(server.manifest?.id ?? id);
      const problems = problemsOf(server);
      if (problems.length > 0) {
        out.push(failedModule(id, server, `invalid manifest: ${problems.join('; ')}`));
        continue;
      }
      if (seen.has(id)) {
        out.push(failedModule(id, server, `duplicate module id "${id}"`));
        continue;
      }
      migrateModule(db, id, server.migrations ?? []);
      db.prepare('INSERT OR IGNORE INTO module_state (module_id) VALUES (?)').run(id);
      const enabled = db.prepare('SELECT enabled FROM module_state WHERE module_id = ?').pluck().get(id) !== 0;
      const host = deps.makeHost(server);
      seen.add(id);
      out.push({ id, server, host, enabled });
    } catch (err) {
      out.push(failedModule(id, server, err instanceof Error ? err.message : String(err)));
    }
  }
  return out;
}
