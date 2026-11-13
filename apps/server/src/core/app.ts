import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type BetterSqlite3 from 'better-sqlite3';
import { CONTRACT_VERSION } from '@dash/contract';
import type { AppConfig, AuthSeam, CoreSeam } from '../seams.js';
import { registerAdminModuleRoutes } from './admin-modules.js';
import { errorHandler } from './errors.js';
import { registerInstanceRoutes, type CoreRouteDeps } from './instances.js';
import type { LoadedModule, LoggerLike, Scheduler, Stream } from './modules/deps.js';
import { registerNotificationRoutes, type NotificationsService } from './notifications.js';
import { registerPageRoutes } from './pages.js';
import type { Snapshots } from './snapshots.js';
import { registerStreamRoutes, type StreamService } from './stream.js';
import { mountModule } from './modules/router.js';
import { DEFAULT_WEB_DIST, registerStatic } from './static.js';

export interface AppDeps {
  config: AppConfig;
  db: BetterSqlite3.Database;
  auth: AuthSeam;
  modules: LoadedModule[];
  /** Built web app directory; defaults to the repo's apps/web/dist. */
  webDistDir?: string;
  /** Fastify logger option; defaults to pino with redaction. Tests pass `false`. */
  logger?: FastifyServerOptions['logger'];
  /** When both are given, `GET /api/stream` and `POST /api/stream/view` are registered. */
  stream?: StreamService;
  scheduler?: Pick<Scheduler, 'markViewed'>;
  /** When given, registers pages, instances, layout, notifications and admin-module routes (task A8). */
  pagesApi?: PagesApiDeps;
}

export interface PagesApiDeps {
  scheduler: Pick<Scheduler, 'syncInstances' | 'register'>;
  stream: Pick<Stream, 'sendToUser' | 'sendSnapshot'>;
  snapshots?: Pick<Snapshots, 'forInstance'>;
  notifications: Pick<NotificationsService, 'api'>;
  audit: CoreSeam['audit'];
  now: () => Date;
  /** Defaults to the app's logger. */
  logger?: LoggerLike;
}

const BODY_LIMIT = 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
};

const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

const DEFAULT_LOGGER = {
  level: 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'res.headers["set-cookie"]',
      'req.body',
    ],
    censor: '[redacted]',
  },
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? DEFAULT_LOGGER,
    bodyLimit: BODY_LIMIT,
  });

  app.addHook('onSend', async (_req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  });
  app.setErrorHandler(errorHandler);

  await app.register(deps.auth.plugin);

  app.get('/api/health', () => ({ ok: true, version: SERVER_VERSION, contract: CONTRACT_VERSION }));

  for (const mod of deps.modules) mountModule(app, mod, deps.auth);

  if (deps.stream && deps.scheduler) {
    registerStreamRoutes(app, { stream: deps.stream, scheduler: deps.scheduler, auth: deps.auth });
  }

  if (deps.pagesApi) {
    const p = deps.pagesApi;
    const routeDeps: CoreRouteDeps = {
      db: deps.db,
      auth: deps.auth,
      modules: deps.modules,
      scheduler: p.scheduler,
      stream: p.stream,
      ...(p.snapshots ? { snapshots: p.snapshots } : {}),
      now: p.now,
      logger: p.logger ?? app.log,
    };
    registerPageRoutes(app, routeDeps);
    registerInstanceRoutes(app, routeDeps);
    registerNotificationRoutes(app, { auth: deps.auth, notifications: p.notifications });
    registerAdminModuleRoutes(app, { ...routeDeps, scheduler: p.scheduler, audit: p.audit });
  }

  // EXTENSION POINT (later tasks): remaining core routes go here,
  // after auth and module mounting and before static/SPA fallback.

  await registerStatic(app, deps.webDistDir ?? DEFAULT_WEB_DIST);
  return app;
}
