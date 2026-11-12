import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './core/app.js';
import { createAuthStub } from './core/auth-stub.js';
import { loadConfig } from './core/config.js';
import { openDb } from './core/db.js';
import { migrateCore } from './core/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'dashboard.sqlite'));
  migrateCore(db);

  const app = await buildApp({ config, db, auth: createAuthStub(), modules: [] });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => db.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
