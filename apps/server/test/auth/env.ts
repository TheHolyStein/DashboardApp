import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type BetterSqlite3 from 'better-sqlite3';
import { createAudit } from '../../src/core/audit.ts';
import { buildApp } from '../../src/core/app.ts';
import { loadConfig } from '../../src/core/config.ts';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createAuth, type CreateAuthOptions } from '../../src/auth/index.ts';
import { createUser, type UserDeps } from '../../src/auth/users.ts';
import type { SessionUser } from '../../src/seams.ts';

export const PASSWORD = 'correct horse battery';

export interface AuthEnv {
  app: FastifyInstance;
  db: BetterSqlite3.Database;
  auth: ReturnType<typeof createAuth>;
  deps: UserDeps;
  /** Mutable injected clock. */
  clock: { now: Date };
  /** Creates a user with PASSWORD (one argon2 hash). */
  addUser(name: string, role?: 'admin' | 'member'): Promise<SessionUser>;
  /** POSTs /api/auth/login; returns the response, the cookie header value and the parsed body. */
  login(name: string, password?: string): Promise<{ res: Awaited<ReturnType<FastifyInstance['inject']>>; cookie: string; csrf: string }>;
}

/** App with the real auth plugin over an in-memory database. Call `app.close()` afterwards. */
export async function makeAuthEnv(
  opts: { modules?: Array<{ id: string; levels: ReadonlyArray<'view' | 'edit'> }>; start?: string; auth?: CreateAuthOptions } = {},
): Promise<AuthEnv> {
  const db = openDb(':memory:');
  migrateCore(db);
  const clock = { now: new Date(opts.start ?? '2026-11-12T10:00:00.000Z') };
  const now = (): Date => clock.now;
  const config = loadConfig({ NODE_ENV: 'test' });
  const audit = createAudit(db, now);
  const auth = createAuth(
    { db, audit, config },
    { now, ...(opts.modules ? { modules: () => opts.modules ?? [] } : {}), ...opts.auth },
  );
  const app = await buildApp({
    config,
    db,
    auth,
    modules: [],
    webDistDir: mkdtempSync(join(tmpdir(), 'dash-auth-web-')),
    logger: false,
  });
  const deps: UserDeps = { db, audit, now, onUserChanged: (id) => auth.notifyUserChanged(id) };
  return {
    app,
    db,
    auth,
    deps,
    clock,
    addUser: (name, role = 'member') => createUser(deps, { name, password: PASSWORD, role }),
    login: async (name, password = PASSWORD) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { name, password },
      });
      const setCookie = res.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = raw ? (raw.split(';')[0] ?? '') : '';
      const csrf = res.statusCode === 200 ? res.json<{ csrf: string }>().csrf : '';
      return { res, cookie, csrf };
    },
  };
}
