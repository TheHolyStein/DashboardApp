import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN, MEMBER } from './fixtures';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log()}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer ${url}/api/health in 30 s:\n${log()}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'apps/server/dist/main.js')) || !existsSync(join(root, 'apps/web/dist/index.html'))) {
    execSync('pnpm build', { cwd: root, stdio: 'inherit' });
  }

  const tmp = mkdtempSync(join(tmpdir(), 'dash-e2e-'));
  const data = join(tmp, 'data');
  const config = join(tmp, 'config');
  mkdirSync(data, { recursive: true });
  mkdirSync(config, { recursive: true });
  const keyFile = join(tmp, 'secret.key');
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });

  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DASH_DATA_DIR: data,
    DASH_CONFIG_DIR: config,
    DASH_SECRET_KEY_FILE: keyFile,
    DASH_PORT: String(port),
  };

  const users = [ADMIN, MEMBER];
  const cli = join(root, 'apps/server/dist/cli.js');
  for (const u of users) {
    execFileSync(process.execPath, [cli, 'user:create', '--name', u.name, '--role', u.role], {
      cwd: root,
      env: { ...env, DASH_PASSWORD: u.password },
      stdio: 'pipe',
    });
  }

  const server = spawn(process.execPath, [join(root, 'apps/server/dist/main.js')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (d: Buffer) => (output += d.toString()));
  server.stderr.on('data', (d: Buffer) => (output += d.toString()));

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseURL, server, () => output);
  } catch (e) {
    server.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  // Workers inherit the environment of the process that ran the global setup.
  process.env['E2E_BASE_URL'] = baseURL;

  return async () => {
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(tmp, { recursive: true, force: true });
  };
}
