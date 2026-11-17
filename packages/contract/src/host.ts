import type { InstanceId, ModuleId, UserId } from './ids.js';
import type { EventName, EventPayload } from './events.js';

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  as?: 'json' | 'text' | 'buffer';          // default 'json'
  ttlSec?: number;                          // cache successful GETs this long; default 0
  timeoutMs?: number;                       // default 10_000, max 30_000
  maxBytes?: number;                        // default 2_000_000, max 20_000_000
  rule?: 'host' | 'publicUrl' | 'lanDevice'; // default 'host'
}

export interface HttpResult<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  fromCache: boolean;
}

export interface Notification {
  level: 'info' | 'warn' | 'critical';
  title: string;
  body?: string;
  /** Translation keys; clients render `t(titleKey, title, vars)`. `title`/`body` stay the English fallback (also used for push). */
  titleKey?: string;
  bodyKey?: string;
  vars?: Record<string, string | number>;
  dedupeKey?: string;                       // same key within 24 h updates instead of adding
  userIds?: UserId[];                       // default: all users with view on this module
  url?: string;                             // deep link inside dashboard
}

// Thin, synchronous-under-the-hood SQLite access restricted to the module's own tables.
export interface ModuleDb {
  run(sql: string, params?: unknown[]): { changes: number };
  all<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | undefined;
  transaction<T>(fn: () => T): T;
}

export interface ModuleInstance<S = unknown> {
  id: InstanceId;
  ownerId: UserId;
  pageId: string;
  settings: S;
}

export interface NotificationRecord {
  id: string;
  moduleId: ModuleId;
  level: 'info' | 'warn' | 'critical';
  title: string;
  body: string | null;
  titleKey: string | null;
  bodyKey: string | null;
  vars: Record<string, string | number> | null;
  url: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface HostServices {
  moduleId: ModuleId;
  http: { fetch<T = unknown>(url: string, opts?: HttpOptions): Promise<HttpResult<T>> };
  store: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(prefix?: string): Promise<string[]>;
    db: ModuleDb;
    blob: {
      // files under <dataDir>/blobs/<moduleId>/; <= 10 MB each, <= 500 MB per module
      put(key: string, data: Uint8Array, contentType: string): Promise<void>;
      get(key: string): Promise<{ data: Uint8Array; contentType: string } | undefined>;
      delete(key: string): Promise<void>;
    };
  };
  // privileged: present only for module ids allow-listed in core (the notifications module)
  notifications?: {
    list(
      userId: UserId,
      opts: { limit: number; before?: string; unreadOnly?: boolean; moduleId?: ModuleId },
    ): Promise<NotificationRecord[]>;
    markRead(userId: UserId, ids: string[] | 'all'): Promise<void>;
    unreadCount(userId: UserId): Promise<number>;
    getMutes(userId: UserId): Promise<Record<ModuleId, string>>;
    setMute(userId: UserId, moduleId: ModuleId, until: string | null): Promise<void>; // ISO time, 'forever', or null to unmute
  };
  secrets: {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  bus: { publish<E extends EventName>(name: E, payload: EventPayload<E>): void };
  push(instanceId: InstanceId | null, data: unknown): void; // null = module-wide snapshot shared by all instances
  notify(n: Notification): void;
  config<C>(): Promise<C>;                                  // module-wide admin config, validated
  instances<S>(): Promise<ModuleInstance<S>[]>;             // all placed instances of this module
  users(): Promise<Array<{ id: UserId; name: string; handle: string }>>; // handle = @mention name
  log: {
    debug(msg: string, f?: object): void;
    info(msg: string, f?: object): void;
    warn(msg: string, f?: object): void;
    error(msg: string, f?: object): void;
  };
  now(): Date;
}
