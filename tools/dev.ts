// `pnpm dev`: server from source (restarted on change) + Vite dev server, one terminal, prefixed output.
// Ctrl-C stops both; if either dies the other is stopped and the exit code is passed on.
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const data = resolve(root, '.data');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DASH_DATA_DIR: data,
  DASH_CONFIG_DIR: resolve(data, 'config'),
  DASH_PORT: '8787',
};

const children: ChildProcess[] = [];
let stopping = false;
let code = 0;

function pipe(stream: NodeJS.ReadableStream, tag: string, out: NodeJS.WriteStream): void {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) out.write(`[${tag}] ${line}\n`);
  });
  stream.on('end', () => {
    if (rest) out.write(`[${tag}] ${rest}\n`);
  });
}

function stopAll(signal: NodeJS.Signals = 'SIGTERM'): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    // Signal the leader only (node --watch forwards it to its own child); the group is killed below if it lingers.
    if (c.pid !== undefined && c.exitCode === null && c.signalCode === null) {
      try {
        process.kill(c.pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => {
    for (const c of children) {
      try {
        if (c.pid !== undefined) process.kill(-c.pid, 'SIGKILL'); // each child leads its own group
      } catch {
        /* group already gone */
      }
    }
    process.exit(code);
  }, 5000).unref();
}

function start(tag: string, cmd: string, args: string[], cwd: string): void {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push(child);
  pipe(child.stdout, tag, process.stdout);
  pipe(child.stderr, tag, process.stderr);
  child.on('exit', (c, s) => {
    if (!stopping) {
      process.stderr.write(`[${tag}] exited (${s ?? c}); stopping the rest\n`);
      code = c ?? 1;
    }
    stopAll();
    if (children.every((x) => x.exitCode !== null || x.signalCode !== null)) process.exit(code);
  });
}

start(
  'server',
  process.execPath,
  [
    '--experimental-transform-types',
    '--import', resolve(root, 'apps/server/src/auth/register-ts.ts'),
    '--watch-path', resolve(root, 'apps/server/src'),
    '--watch-path', resolve(root, 'packages/contract/src'),
    '--watch-path', resolve(root, 'packages/module-kit/src'),
    '--watch-preserve-output',
    resolve(root, 'apps/server/src/main.ts'),
  ],
  resolve(root, 'apps/server'),
);
start('web', process.execPath, [resolve(root, 'apps/web/node_modules/vite/bin/vite.js')], resolve(root, 'apps/web'));

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
