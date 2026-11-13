// Dependency interfaces consumed by the module loader, host factory and router. Later tasks
// implement them (see the report of task A3); tests in this task use in-test fakes.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  EventName,
  HostServices,
  InstanceId,
  ModuleId,
  ModuleInstance,
  ModuleManifest,
  ModuleServer,
  Notification,
  UserId,
} from '@dash/contract';

/** What the auth track's plugin exposes per request (decorated by the plugin, null when none). */
export interface RequestSession {
  /** CSRF token bound to the session; non-GET module requests must send it as `X-CSRF`. */
  csrf: string;
}
declare module 'fastify' {
  interface FastifyRequest {
    /** Decorated by the auth plugin (task B). Null/undefined for requests without a session. */
    session?: RequestSession | null;
  }
}

/** A module after loading. When `failed` is set, `server`/`host` are placeholders and must not be used. */
export interface LoadedModule {
  id: ModuleId;
  server: ModuleServer;
  host: HostServices;
  /** Read per request by the router; the admin task flips it at runtime. */
  enabled: boolean;
  /** Reason the module could not be loaded; the module is then unreachable (404) and not scheduled. */
  failed?: string;
}

// ---- A4 (copied from the A4 brief) ---------------------------------------------------------------
export interface Scheduler {
  register(mod: LoadedModule): void;
  markViewed(instanceIds: InstanceId[], at: Date): void;
  setMinimal(on: boolean): void;
  runNow(moduleId: ModuleId, job: string, instanceId?: InstanceId): Promise<void>;
  status(): Array<{
    moduleId: ModuleId;
    job: string;
    instanceId: InstanceId | null;
    lastRunAt: string | null;
    lastOkAt: string | null;
    failures: number;
    nextRunAt: string | null;
  }>;
  start(): void;
  stop(): Promise<void>;
}

// ---- A7 (copied from the A7 brief, plus sendCore) ------------------------------------------------
export interface StreamEvent {
  type: string;
  data?: unknown;
}
export interface Bus {
  publish(from: ModuleId /* or 'core' */, name: EventName, payload: unknown): void;
  subscribe(moduleId: ModuleId /* or 'core' */, name: EventName, fn: (payload: unknown) => void | Promise<void>): void;
}
export interface Stream {
  handle(req: FastifyRequest, reply: FastifyReply): void;
  sendSnapshot(moduleId: ModuleId, instanceId: InstanceId | null, snap: unknown): void;
  sendToUser(userId: UserId, ev: StreamEvent): void;
  disconnectUser(userId: UserId, moduleId?: ModuleId): void;
  sendCore(key: string, data: unknown, userIds?: UserId[]): void;
}

// ---- Factory-shaped dependencies (implemented by A4-A8) -------------------------------------------
/** Outbound HTTP for one module, enforcing its manifest `outbound` rules (task A5). */
export type HttpFactory = (moduleId: ModuleId, manifest: ModuleManifest) => HostServices['http'];

/** kv + blob store for one module (task A6). `db` is NOT part of it: createHost builds it. */
export type StoreFactory = (moduleId: ModuleId) => Omit<HostServices['store'], 'db'>;

/** Encrypted per-module secrets (task A6). */
export type SecretsFactory = (moduleId: ModuleId) => HostServices['secrets'];

/** Stores a module's snapshot, applies the 256 KB cap, then streams it (task A7). */
export interface SnapshotsDep {
  push(moduleId: ModuleId, instanceId: InstanceId | null, data: unknown): void;
}

/** Notification service (task A8). `privileged` returns the cross-module API only for allow-listed ids. */
export interface NotificationsDep {
  notify(moduleId: ModuleId, n: Notification): void;
  privileged(moduleId: ModuleId): HostServices['notifications'] | undefined;
}

/** Module-wide admin config and placed instances (tasks A6/A8: pages + module admin). */
export interface ModuleStateDep {
  /** Raw stored config JSON (undefined when never set); createHost validates it with manifest.config. */
  config(moduleId: ModuleId): Promise<unknown>;
  instances(moduleId: ModuleId): Promise<ModuleInstance[]>;
}

/** Minimal logger surface (a Fastify/pino logger satisfies it). */
export interface LoggerLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): LoggerLike;
}

export type { ModuleServer };
