import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type BetterSqlite3 from 'better-sqlite3';
import { CONTRACT_VERSION, type ModuleServer } from '@dash/contract';
import type { AppConfig, AuthSeam } from '../seams.js';
import { errorHandler } from './errors.js';
import { DEFAULT_WEB_DIST, registerStatic } from './static.js';

export interface AppDeps {
  config: AppConfig;
  db: BetterSqlite3.Database;
  auth: AuthSeam;
  modules: ModuleServer[];
  /** Built web app directory; defaults to the repo's apps/web/dist. */
  webDistDir?: string;
  /** Fastify logger option; defaults to pino with redaction. Tests pass `false`. */
  logger?: FastifyServerOptions['logger'];
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

  // EXTENSION POINT (later tasks): mount `deps.modules` and the other core routes
  // (pages, instances, stream, ...) here, after auth and before static/SPA fallback.

  await registerStatic(app, deps.webDistDir ?? DEFAULT_WEB_DIST);
  return app;
}
