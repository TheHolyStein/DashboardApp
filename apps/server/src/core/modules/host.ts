import type BetterSqlite3 from 'better-sqlite3';
import {
  DashError,
  type HostServices,
  type ModuleId,
  type ModuleInstance,
  type ModuleManifest,
} from '@dash/contract';
import type { AuthSeam } from '../../seams.js';
import { createModuleDb } from './module-db.js';
import type {
  Bus,
  HttpFactory,
  LoggerLike,
  ModuleStateDep,
  NotificationsDep,
  SecretsFactory,
  SnapshotsDep,
  StoreFactory,
} from './deps.js';

export interface HostDeps {
  manifest: ModuleManifest;
  db: BetterSqlite3.Database;
  http: HttpFactory;
  store: StoreFactory;
  bus: Bus;
  snapshots: SnapshotsDep;
  notifications: NotificationsDep;
  auth: Pick<AuthSeam, 'listUsers'>;
  state: ModuleStateDep;
  secrets: SecretsFactory;
  logger: LoggerLike;
  now: () => Date;
}

/** Builds the only object a module sees of the core. Everything is bound to `moduleId`. */
export function createHost(moduleId: ModuleId, deps: HostDeps): HostServices {
  const log = deps.logger.child({ module: moduleId });
  const privileged = deps.notifications.privileged(moduleId);
  return {
    moduleId,
    http: deps.http(moduleId, deps.manifest),
    store: { ...deps.store(moduleId), db: createModuleDb(deps.db, moduleId) },
    ...(privileged === undefined ? {} : { notifications: privileged }),
    secrets: deps.secrets(moduleId),
    bus: { publish: (name, payload) => deps.bus.publish(moduleId, name, payload) },
    push: (instanceId, data) => deps.snapshots.push(moduleId, instanceId, data),
    notify: (n) => deps.notifications.notify(moduleId, n),
    async config<C>(): Promise<C> {
      const parsed = deps.manifest.config.safeParse((await deps.state.config(moduleId)) ?? {});
      if (!parsed.success) {
        throw new DashError('invalid', `config of module ${moduleId} is invalid`, parsed.error.issues);
      }
      return parsed.data as C;
    },
    async instances<S>(): Promise<ModuleInstance<S>[]> {
      return (await deps.state.instances(moduleId)) as ModuleInstance<S>[];
    },
    users: () => Promise.resolve(deps.auth.listUsers().map((u) => ({ id: u.id, name: u.name, handle: u.handle }))),
    log: {
      debug: (msg, f) => log.debug(f ?? {}, msg),
      info: (msg, f) => log.info(f ?? {}, msg),
      warn: (msg, f) => log.warn(f ?? {}, msg),
      error: (msg, f) => log.error(f ?? {}, msg),
    },
    now: deps.now,
  };
}
