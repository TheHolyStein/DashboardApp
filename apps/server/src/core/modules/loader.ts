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

/** Per-module time limits for the lifecycle hooks. */
export const SETUP_TIMEOUT_MS = 5_000;
export const TEARDOWN_TIMEOUT_MS = 3_000;

/** Runs `fn`, rejecting with a timeout error after `ms`. The hook itself cannot be cancelled; it is abandoned. */
export async function withTimeout(fn: () => void | Promise<void>, ms: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
      setupRan: false,
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
      const setup = server.setup;
      let setupRan = false;
      if (enabled && setup) {
        try {
          await withTimeout(() => setup(host), SETUP_TIMEOUT_MS, 'setup');
          setupRan = true;
        } catch (err) {
          out.push(failedModule(id, server, `setup failed: ${err instanceof Error ? err.message : String(err)}`));
          continue;
        }
      }
      seen.add(id);
      out.push({ id, server, host, enabled, setupRan: setupRan || (enabled && !setup) });
    } catch (err) {
      out.push(failedModule(id, server, err instanceof Error ? err.message : String(err)));
    }
  }
  return out;
}

/** Tears one module down if its `setup` ran (bounded, errors logged), and marks it as not set up. */
export async function teardownModule(mod: LoadedModule, logger: LoggerLike): Promise<void> {
  if (mod.failed !== undefined || !mod.setupRan) return;
  mod.setupRan = false;
  const teardown = mod.server.teardown;
  if (!teardown) return;
  try {
    await withTimeout(() => teardown(mod.host), TEARDOWN_TIMEOUT_MS, 'teardown');
  } catch (err) {
    logger.error({ module: mod.id, err: err instanceof Error ? err.message : String(err) }, 'module teardown failed');
  }
}

/**
 * Calls `teardown` on every module whose `setup` ran (a module that was disabled at start, failed or never set up is
 * skipped), errors logged, never thrown. Call on shutdown before the database closes.
 * Each teardown is bounded by TEARDOWN_TIMEOUT_MS and they run concurrently (`Promise.allSettled`): sequential runs
 * would let four slow modules (4 x 3 s) exceed the 10 s shutdown limit in main.ts, whereas concurrently the total
 * stays at one timeout (3 s) however many modules hang. Modules are independent, so order does not matter.
 */
export async function teardownModules(modules: readonly LoadedModule[], logger: LoggerLike): Promise<void> {
  await Promise.allSettled(modules.map((mod) => teardownModule(mod, logger)));
}
