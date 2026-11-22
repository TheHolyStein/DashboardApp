import type { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BinaryResponse,
  DashError,
  type ModuleInstance,
  type ModuleRouter,
  type RouteHandler,
  type RouteOptions,
  type RouteRequest,
} from '@dash/contract';
import type { AuthSeam, SessionUser } from '../../seams.js';
import type { LoadedModule } from './deps.js';
import { requireCsrf } from '../csrf.js';
import { ROOT_MOUNT_ALLOW } from './loader.js';

type RawHandler = Parameters<ModuleRouter['raw']>[1];

const WEBDAV_METHODS = [
  'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'REPORT', 'MKCALENDAR', 'SEARCH',
];

export const INSTANCE_HEADER = 'x-dash-instance';

/** Request headers for module handlers: never the session cookie; `x-dash-instance` only as `req.instance`; `authorization` only when asked for (appPassword mounts). */
function headersOf(request: FastifyRequest, withAuthorization = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (k === 'cookie' || k === INSTANCE_HEADER || (k === 'authorization' && !withAuthorization)) continue;
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function userOf(u: SessionUser): RouteRequest['user'] {
  return { id: u.id, name: u.name, role: u.role };
}

/** Module must be loaded and enabled right now (evaluated per request). */
function requireAvailable(mod: LoadedModule): void {
  if (mod.failed !== undefined || !mod.enabled || !mod.setupRan) throw new DashError('not_found', 'Not found');
}

function resolveLevel(auth: AuthSeam, user: SessionUser, mod: LoadedModule): 'view' | 'edit' {
  const level = auth.levelFor(user.id, mod.id);
  if (level === 'none') throw new DashError('forbidden', 'No access to this module');
  return level;
}

/**
 * The instance in `x-dash-instance`, if it belongs to this module and sits on a page the user owns or that is shared
 * (the pages API rule; no admin exception). Every failure is the same 404.
 */
function resolveInstance(
  db: BetterSqlite3.Database,
  request: FastifyRequest,
  user: SessionUser,
  mod: LoadedModule,
  mode: 'required' | 'optional' | undefined,
): ModuleInstance<unknown> | null {
  if (mode === undefined) return null;
  const raw = request.headers[INSTANCE_HEADER];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (id === undefined || id === '') {
    if (mode === 'optional') return null;
    throw new DashError('not_found', 'Not found');
  }
  const row = db
    .prepare(
      `SELECT i.id AS id, i.page_id AS pageId, i.settings AS settings, p.owner_id AS ownerId, p.shared AS shared
       FROM instances i JOIN pages p ON p.id = i.page_id WHERE i.id = ? AND i.module_id = ?`,
    )
    .get(id, mod.id) as { id: string; pageId: string; settings: string; ownerId: string; shared: number } | undefined;
  if (!row || (row.ownerId !== user.id && row.shared !== 1)) throw new DashError('not_found', 'Not found');
  return { id: row.id, ownerId: row.ownerId, pageId: row.pageId, settings: JSON.parse(row.settings) as unknown };
}

function validate<T>(schema: z.ZodType<T> | undefined, value: unknown, where: 'body' | 'query'): T {
  if (schema === undefined) return value as T;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DashError('invalid', `Invalid ${where}`, { in: where, issues: parsed.error.issues });
  }
  return parsed.data;
}

async function sendResult(reply: FastifyReply, result: unknown): Promise<FastifyReply> {
  if (result instanceof BinaryResponse) {
    reply.type(result.contentType).header('X-Content-Type-Options', 'nosniff');
    if (result.cacheControl !== undefined) reply.header('Cache-Control', result.cacheControl);
    return reply.send(Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength));
  }
  if (result === undefined) return reply.status(204).send();
  return reply.type('application/json; charset=utf-8').send(JSON.stringify(result));
}

function ensureWebdavMethods(app: FastifyInstance): void {
  for (const m of WEBDAV_METHODS) {
    if (!app.supportedMethods.includes(m)) app.addHttpMethod(m, { hasBody: true });
  }
}

/**
 * Mounts a module's routes under /api/m/<id> (nothing for a failed module). Per request, in this order: requireUser (401), module
 * failed/disabled (404), user level none (403), edit route with view level (403), CSRF for non-GET
 * (403), zod validation of query/body (422), instance (404), handler. Enabled flag and level are read per request.
 */
export function mountModule(app: FastifyInstance, mod: LoadedModule, auth: AuthSeam, db: BetterSqlite3.Database): void {
  if (mod.failed !== undefined) return; // not mounted: /api/m/<id>/* falls through to the global 404
  const base = `/api/m/${mod.id}`;

  const register = <B, Q>(method: string, path: string, opts: RouteOptions<B, Q>, h: RouteHandler<B, Q>): void => {
    app.route({
      method,
      url: `${base}${path}`,
      handler: async (request, reply) => {
        const user = auth.requireUser(request);
        requireAvailable(mod);
        const level = resolveLevel(auth, user, mod);
        if (opts.level === 'edit' && level !== 'edit') throw new DashError('forbidden', 'Edit access required');
        requireCsrf(request);
        const query = validate(opts.query, request.query, 'query');
        const body = validate(opts.body, request.body, 'body');
        const instance = resolveInstance(db, request, user, mod, opts.instance);
        const result = await h({ // sync or async handler
          user: userOf(user),
          level,
          params: { ...(request.params as Record<string, string>) },
          query,
          body,
          headers: headersOf(request),
          instance,
          raw: request.raw,
        });
        return sendResult(reply, result);
      },
    });
  };

  const rawMount: ModuleRouter['raw'] = (prefix: string, h: RawHandler) => {
    const mount = (mod.server.manifest.rootMounts ?? []).find((r) => r.prefix === prefix);
    const allowed = Object.hasOwn(ROOT_MOUNT_ALLOW, mod.id) ? (ROOT_MOUNT_ALLOW[mod.id] as string[]) : [];
    if (mount === undefined || !allowed.includes(prefix)) {
      throw new DashError('forbidden', `root mount "${prefix}" is not allowed for module ${mod.id}`);
    }
    ensureWebdavMethods(app);
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin signature
    void app.register(async (scope) => {
      // Raw Buffer bodies for every content type, in this scope only.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
      const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
        let user: SessionUser;
        if (mount.auth === 'appPassword') {
          const u = auth.verifyAppPassword(request.headers.authorization);
          if (u === null) {
            reply.header('WWW-Authenticate', 'Basic realm="dashboard", charset="UTF-8"');
            throw new DashError('unauthenticated', 'Authentication required');
          }
          user = u;
        } else {
          user = auth.requireUser(request);
        }
        requireAvailable(mod);
        const level = resolveLevel(auth, user, mod);
        if (mount.auth !== 'appPassword') requireCsrf(request);
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const res = await h({
          user: userOf(user),
          level,
          params: { ...(request.params as Record<string, string>) },
          query: request.query,
          body: rawBody,
          headers: headersOf(request, mount.auth === 'appPassword'),
          instance: null,
          raw: request.raw,
          method: request.method,
          path: request.url.split('?')[0] ?? request.url,
          rawBody,
        });
        reply.status(res.status);
        for (const [k, v] of Object.entries(res.headers ?? {})) reply.header(k, v);
        return reply.send(res.body);
      };
      const methods = app.supportedMethods.filter((m) => m !== 'HEAD'); // HEAD is derived from GET
      for (const url of [prefix, `${prefix}/*`]) scope.route({ method: methods, url, handler });
    });
  };

  const router: ModuleRouter = {
    get: (p, o, h) => register('GET', p, o, h),
    post: (p, o, h) => register('POST', p, o, h),
    put: (p, o, h) => register('PUT', p, o, h),
    patch: (p, o, h) => register('PATCH', p, o, h),
    delete: (p, o, h) => register('DELETE', p, o, h),
    raw: rawMount,
  };

  try {
    mod.server.routes?.(router, mod.host);
  } catch (err) {
    // routes already registered stay, but requireAvailable() now answers 404 for them
    mod.failed = `route registration failed: ${err instanceof Error ? err.message : String(err)}`;
    app.log.error({ module: mod.id, err }, 'module route registration failed');
  }

  // Unknown paths under the module go through the same gate, then 404.
  const unknown = (request: FastifyRequest): never => {
    const user = auth.requireUser(request);
    requireAvailable(mod);
    resolveLevel(auth, user, mod);
    throw new DashError('not_found', 'Not found');
  };
  app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: `${base}/*`, handler: unknown });
  app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: base, handler: unknown });
}
