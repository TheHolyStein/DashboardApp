// Composition root of the server: builds the service graph (auth, bus, snapshots, modules, stream,
// scheduler, notifications, ...) from `{ config, db, now, logger }`. No business logic lives here; the
// process concerns (signals, listen, timers) are in main.ts. Tests call this same function.
import dns from 'node:dns';
import type BetterSqlite3 from 'better-sqlite3';
import type { HostServices } from '@dash/contract';
import { createAuth, purgeExpiredSessions, type Auth } from '../auth/index.js';
import type { AppConfig } from '../seams.js';
import { serverModules } from '../generated/modules.js';
import type { AppDeps } from './app.js';
import { createAudit } from './audit.js';
import { createBus, wireModuleSubscriptions } from './bus.js';
import { createHttp, purgeExpiredCache } from './http/client.js';
import { createInstanceReader, createModuleState } from './instances.js';
import { createHost } from './modules/host.js';
import { loadModules, teardownModules } from './modules/loader.js';
import type { LoadedModule, LoggerLike, Scheduler } from './modules/deps.js';
import { createNotifications, purgeOldNotifications, type NotificationsService } from './notifications.js';
import { ensureStarterPage } from './pages.js';
import { createScheduler } from './scheduler.js';
import { createSecretsFactory, loadSecretKey } from './secrets.js';
import { createSnapshots, type Snapshots } from './snapshots.js';
import { createStoreFactory } from './store.js';
import { createStream, type StreamService } from './stream.js';
import { createVisibility } from './visibility.js';

export interface ComposeDeps {
  config: AppConfig;
  db: BetterSqlite3.Database;
  /** The only real clock in the process is created by the caller (main.ts); everything else receives it. */
  now: () => Date;
  logger: LoggerLike;
  /** Defaults to the generated registry; tests pass their own. */
  registry?: Parameters<typeof loadModules>[0];
  random?: () => number;
}

export interface Composed {
  auth: Auth;
  modules: LoadedModule[];
  stream: StreamService;
  scheduler: Scheduler;
  snapshots: Snapshots;
  notifications: NotificationsService;
  /** Everything `buildApp` needs besides `config`, `db`, `webDistDir` and `logger`. */
  appDeps: Pick<AppDeps, 'auth' | 'modules' | 'stream' | 'scheduler' | 'pagesApi'>;
  /** One housekeeping pass: every purge isolated in try/catch and logged. */
  housekeeping(): void;
  /** Runs every module's `teardown`; call on shutdown before the database closes. */
  teardown(): Promise<void>;
}

/** Module-admin convention: the string array at key `lanHosts` of a module's stored config (else empty). */
export function lanHostsOf(db: BetterSqlite3.Database, moduleId: string): string[] {
  const raw = db.prepare('SELECT config FROM module_state WHERE module_id = ?').pluck().get(moduleId) as
    | string
    | null
    | undefined;
  if (!raw) return [];
  try {
    const hosts = (JSON.parse(raw) as { lanHosts?: unknown }).lanHosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

export async function compose(deps: ComposeDeps): Promise<Composed> {
  const { config, db, now, logger } = deps;
  const audit = createAudit(db, now);
  // A missing or badly permissioned key file aborts startup here (production), before anything listens.
  const secretKey = loadSecretKey(config);

  // Filled after loadModules; the closures below read it lazily.
  const modules: LoadedModule[] = [];
  const manifests = (id: string) => modules.find((m) => m.id === id)?.server.manifest;

  const auth = createAuth(
    { db, audit, config },
    {
      now,
      secretKey,
      hooks: { onUserCreated: (id) => void ensureStarterPage(db, id, now) },
      modules: () =>
        modules.filter((m) => m.failed === undefined).map((m) => ({ id: m.id, levels: m.server.manifest.levels })),
    },
  );

  // `stream` needs snapshots and auth, while snapshots and notifications need `stream` when they fire.
  let stream: StreamService;
  const bus = createBus({ manifests, logger });
  const snapshots = createSnapshots({
    db,
    now,
    manifests,
    logger,
    onStored: (moduleId, instanceId, snap) => stream.sendSnapshot(moduleId, instanceId, snap),
  });
  const notifications = createNotifications({
    db,
    auth,
    bus,
    stream: { sendToUser: (userId, ev) => stream.sendToUser(userId, ev) },
    now,
    logger,
  });
  const state = createModuleState(db);
  const store = createStoreFactory({ db, dataDir: config.dataDir });
  const secrets = createSecretsFactory({ db, key: secretKey });

  const loaded = await loadModules(deps.registry ?? serverModules, db, {
    logger,
    makeHost: (server): HostServices =>
      createHost(server.manifest.id, {
        manifest: server.manifest,
        db,
        http: (id, manifest) => createHttp(id, manifest, { db, lookup: dns.lookup, lanDevices: (mid) => lanHostsOf(db, mid), now }),
        store,
        bus,
        snapshots,
        notifications,
        auth,
        state,
        secrets,
        logger,
        now,
      }),
  });
  // Setup already ran inside loadModules: if anything below throws, tear those modules down before rethrowing.
  try {
    modules.push(...loaded);
    for (const mod of modules) wireModuleSubscriptions(bus, mod);

    const visibility = createVisibility(db, () => auth.listUsers().map((u) => u.id));
    stream = createStream({ auth, snapshots, visibility, now, logger });
    stream.sendCore('core:offline', { offline: false });

    // The scheduler flags a failed job's snapshot itself (job_ok = 0 → stale at send time).
    const scheduler = createScheduler({
      db,
      now,
      random: deps.random ?? Math.random,
      instances: createInstanceReader(db),
      logger,
    });
    for (const mod of modules) scheduler.register(mod);

    const housekeeping = (): void => {
      const at = now();
      const steps: Array<[string, () => unknown]> = [
        ['http cache', () => purgeExpiredCache(db, at)],
        ['notifications', () => purgeOldNotifications(db, at)],
        ['sessions', () => purgeExpiredSessions(db, at)],
        ['login limiter', () => auth.loginLimiter.purge(at)],
      ];
      for (const [name, run] of steps) {
        try {
          const removed = run();
          logger.info({ purge: name, ...(typeof removed === 'number' ? { removed } : {}) }, 'housekeeping');
        } catch (err) {
          logger.error({ purge: name, err: err instanceof Error ? err.message : String(err) }, 'housekeeping failed');
        }
      }
    };

    return {
      auth,
      modules,
      stream,
      scheduler,
      snapshots,
      notifications,
      appDeps: {
        auth,
        modules,
        stream,
        scheduler,
        pagesApi: { scheduler, stream, snapshots, notifications, audit, now, logger },
      },
      housekeeping,
      teardown: () => teardownModules(modules, logger),
    };
  } catch (err) {
    await teardownModules(loaded, logger);
    throw err;
  }
}
