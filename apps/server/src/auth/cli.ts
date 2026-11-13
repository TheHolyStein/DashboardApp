// Thin admin CLI: `pnpm --filter @dash/server cli user:create --name <n> --role admin|member`.
// Password: DASH_PASSWORD when set (install script), else prompted without echo on a TTY, else stdin.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import { migrateCore } from '../core/migrate.js';
import { ensureStarterPage } from '../core/pages.js';
import { createAudit } from '../core/audit.js';
import { createUser } from './users.js';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new Error('Aborted'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function readPassword(): Promise<string> {
  const env = process.env['DASH_PASSWORD'];
  if (env !== undefined && env !== '') return env;
  if (process.stdin.isTTY) return readHidden('Password: ');
  return readStdin();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'user:create') throw new Error('Usage: cli user:create --name <name> --role admin|member');
  const { values } = parseArgs({ args: rest, options: { name: { type: 'string' }, role: { type: 'string' } } });
  if (!values.name) throw new Error('--name is required');
  if (values.role !== 'admin' && values.role !== 'member') throw new Error('--role must be admin or member');

  const password = await readPassword();
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'dashboard.sqlite'));
  try {
    migrateCore(db);
    const now = (): Date => new Date();
    const user = await createUser(
      {
        db,
        audit: createAudit(db, now),
        now,
        onUserCreated: (id) => {
          ensureStarterPage(db, id, now);
        },
      },
      { name: values.name, password, role: values.role },
    );
    console.log(user.id);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
