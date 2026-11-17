// Process entry: builds the service graph (core/compose.ts), starts listening and owns the process
// concerns (signals, housekeeping timer). `start()` is also what the wiring tests call.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type BetterSqlite3 from 'better-sqlite3';
import { CONTRACT_VERSION } from '@dash/contract';
import { buildApp } from './core/app.js';
import { compose, type ComposeDeps, type Composed } from './core/compose.js';
import { loadConfig } from './core/config.js';
import { openDb } from './core/db.js';
import { createDeferredLogger } from './core/logger.js';
import { migrateCore } from './core/migrate.js';
import { SERVER_VERSION } from './core/version.js';

export interface Started {
  app: FastifyInstance;
  db: BetterSqlite3.Database;
  services: Composed;
  /** Base URL actually bound, e.g. `http://127.0.0.1:8787` (the real port when DASH_PORT=0). */
  address: string;
  /** Stops jobs and streams, closes the server and the database. Idempotent. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** Fastify logger option; `false` silences everything (tests). Default: pino with redaction. */
  logger?: FastifyServerOptions['logger'];
  /** Built web app directory; default apps/web/dist. */
  webDistDir?: string;
  /** Replaces the generated module registry (tests only). */
  registry?: ComposeDeps['registry'];
}

const HOUSEKEEPING_FIRST_MS = 60_000;
const HOUSEKEEPING_EVERY_MS = 3_600_000;

export async function start(env: NodeJS.ProcessEnv = process.env, opts: StartOptions = {}): Promise<Started> {
  const config = loadConfig(env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'dashboard.sqlite'));
  let services: Composed | undefined;
  let app: FastifyInstance | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    migrateCore(db);
    const now = (): Date => new Date(); // the only real clock in the process
    const logger = createDeferredLogger(opts.logger !== false);
    services = await compose({ config, db, now, logger, ...(opts.registry ? { registry: opts.registry } : {}) });
    app = await buildApp({
      config,
      db,
      ...services.appDeps,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.webDistDir !== undefined ? { webDistDir: opts.webDistDir } : {}),
    });
    logger.attach(app.log);
    await app.listen({ host: config.host, port: config.port });
    services.scheduler.start();

    const running = services;
    const tick = (): void => {
      running.housekeeping();
      timer = setTimeout(tick, HOUSEKEEPING_EVERY_MS).unref();
    };
    timer = setTimeout(tick, HOUSEKEEPING_FIRST_MS).unref();

    const failed = services.modules.filter((m) => m.failed !== undefined).length;
    const bound = app.server.address();
    const port = typeof bound === 'object' && bound ? bound.port : config.port;
    app.log.info(
      {
        version: SERVER_VERSION,
        contract: CONTRACT_VERSION,
        port,
        dataDir: config.dataDir,
        modulesLoaded: services.modules.length - failed,
        modulesFailed: failed,
      },
      'dashboard started',
    );

    const live = app;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        if (timer) clearTimeout(timer);
        try {
          await running.scheduler.stop();
          await live.close(); // closes streams (preClose hook) and stops accepting
        } finally {
          try {
            await running.teardown();
          } finally {
            db.close();
          }
        }
      })());
    return { app, db, services, address: `http://${config.host}:${port}`, close };
  } catch (err) {
    if (timer) clearTimeout(timer);
    try {
      await services?.scheduler.stop();
      await app?.close();
    } finally {
      if (db.open) db.close();
    }
    throw err;
  }
}

function installSignalHandlers(started: Started): void {
  let signalled = false;
  const shutdown = (signal: string): void => {
    if (signalled) {
      started.app.log.error({ signal }, 'second signal, exiting now');
      process.exit(1);
    }
    signalled = true;
    started.app.log.info({ signal }, 'shutting down');
    setTimeout(() => {
      started.app.log.error('shutdown timed out');
      process.exit(1);
    }, 10_000).unref();
    started.close().then(
      () => {
        process.exitCode = 0;
      },
      (err: unknown) => {
        started.app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === realpathSync(entry)) {
  start().then(installSignalHandlers, (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
