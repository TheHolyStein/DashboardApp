import type { z } from 'zod';
import type { EventName, EventPayload } from './events.js';
import type { UserId } from './ids.js';
import type { ModuleManifest } from './manifest.js';
import type { HostServices, ModuleInstance } from './host.js';

// Route handlers return JSON-serialisable values, or a BinaryResponse for files.
export class BinaryResponse {
  constructor(public data: Uint8Array, public contentType: string, public cacheControl?: string) {}
}

export interface JobContext<S = unknown> {
  host: HostServices;
  instance: ModuleInstance<S> | null;
  signal: AbortSignal;
}

export interface RouteRequest<B = unknown, Q = unknown> {
  user: { id: UserId; name: string; role: 'admin' | 'member' };
  level: 'view' | 'edit';
  params: Record<string, string>;
  query: Q;
  body: B;
  headers: Record<string, string>;
  /**
   * The instance named by the client's `x-dash-instance` header, resolved and access-checked by the server when the
   * route declares `instance: 'required' | 'optional'`; otherwise null. Its `settings` are the stored (unparsed)
   * value: parse them with `manifest.settings`. Typed `unknown` rather than generic to keep `ModuleRouter` simple.
   */
  instance: ModuleInstance<unknown> | null;
  raw: unknown;
}

export interface RouteOptions<B = unknown, Q = unknown> {
  level: 'view' | 'edit';
  /** Validated by the server (422 on failure); `req.body` is then `z.infer` of it. */
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  /**
   * Resolve the instance the client sent in `x-dash-instance` into `req.instance`. The instance must belong to this
   * module and sit on a page the caller may view (owner, or a page shared with them; admins get no extra access).
   * `'required'`: missing, invalid, foreign or not visible answers 404 `not_found` (same response for all).
   * `'optional'`: absent gives null; present but not visible is still 404. Default: not resolved (null).
   * Never take an instance id from the query or body for access decisions; the raw header is not passed to handlers.
   */
  instance?: 'required' | 'optional';
}

/** May return a value or a promise of one (`unknown` already covers `Promise<unknown>`). */
export type RouteHandler<B = unknown, Q = unknown> = (req: RouteRequest<B, Q>) => unknown;

export interface ModuleRouter {
  get<B = unknown, Q = unknown>(path: string, opts: RouteOptions<B, Q>, h: RouteHandler<B, Q>): void;
  post<B = unknown, Q = unknown>(path: string, opts: RouteOptions<B, Q>, h: RouteHandler<B, Q>): void;
  put<B = unknown, Q = unknown>(path: string, opts: RouteOptions<B, Q>, h: RouteHandler<B, Q>): void;
  patch<B = unknown, Q = unknown>(path: string, opts: RouteOptions<B, Q>, h: RouteHandler<B, Q>): void;
  delete<B = unknown, Q = unknown>(path: string, opts: RouteOptions<B, Q>, h: RouteHandler<B, Q>): void;
  // only for manifest.rootMounts
  raw(
    prefix: string,
    h: (req: RouteRequest & { method: string; path: string; rawBody: Buffer }) => Promise<RawResponse>,
  ): void;
}

export interface RawResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface Migration {
  id: number; // ids ascending from 1
  up: string; // SQL; only m_<id>_ tables
}

export interface ModuleServer<S = unknown> {
  manifest: ModuleManifest;
  migrations?: Migration[];
  /**
   * Called once per loaded, enabled module, after migrations and before the first job, route or event handler runs.
   * Keep per-host state (snapshot pusher, caches) in a closure created here, never at module scope.
   * A throw, a rejection or running longer than 5 s marks the module failed (and `teardown` is not called), so
   * `setup` must clean up after itself (timers, subscriptions) when it fails part-way.
   */
  setup?: (host: HostServices) => void | Promise<void>;
  /**
   * Called on server shutdown, before the database closes, only for modules whose `setup` succeeded (never for a
   * module that was disabled at start and not enabled since). Errors are logged and ignored; it is abandoned after 3 s.
   */
  teardown?: (host: HostServices) => void | Promise<void>;
  // keys must equal manifest.jobs[].name
  jobs?: Record<string, (ctx: JobContext<S>) => Promise<void>>;
  routes?: (r: ModuleRouter, host: HostServices) => void;
  // keys must be in manifest.subscribes
  on?: { [E in EventName]?: (payload: EventPayload<E>, host: HostServices) => Promise<void> };
  onInstanceChange?: (
    kind: 'added' | 'updated' | 'removed',
    instance: ModuleInstance<S>,
    host: HostServices,
  ) => Promise<void>;
}
