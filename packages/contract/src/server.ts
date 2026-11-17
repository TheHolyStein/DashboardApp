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
  raw: unknown;
}

export interface RouteOptions<B = unknown, Q = unknown> {
  level: 'view' | 'edit';
  /** Validated by the server (422 on failure); `req.body` is then `z.infer` of it. */
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
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
