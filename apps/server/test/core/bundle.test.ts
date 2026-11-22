// Builds the production bundle and boots it as a separate process (slow).
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const serverDir = fileURLToPath(new URL('../../', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('production bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'dash-bundle-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DASH_DATA_DIR: join(root, 'data'),
    DASH_CONFIG_DIR: join(root, 'config'),
  };

  beforeAll(async () => {
    await run('node', ['build.mjs'], { cwd: serverDir });
  }, 120_000);

  it('cli creates a user, then the bundled server boots, answers health, and exits 0 on SIGTERM', async () => {
    const cli = await run('node', ['dist/cli.js', 'user:create', '--name', 'Smoke Admin', '--role', 'admin'], {
      cwd: serverDir,
      env: { ...env, DASH_PASSWORD: 'correct horse battery' },
    });
    expect(cli.stdout.trim()).toMatch(/^\S{8,}$/);

    const port = await freePort();
    const child = spawn('node', ['dist/main.js'], {
      cwd: serverDir,
      env: { ...env, DASH_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d: Buffer) => (log += d.toString()));
    child.stderr.on('data', (d: Buffer) => (log += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

    try {
      let ok = false;
      for (let i = 0; i < 100 && !ok && child.exitCode === null; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          ok = res.status === 200;
          if (ok) expect(await res.json()).toMatchObject({ ok: true, contract: 1 });
        } catch {
          await sleep(200);
        }
      }
      expect(ok, `server did not become healthy:\n${log}`).toBe(true);

      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Smoke Admin', password: 'correct horse battery' }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const pages = await fetch(`http://127.0.0.1:${port}/api/pages`, { headers: { cookie } });
      expect(JSON.stringify(await pages.json())).toContain('Today');
      expect(log).toContain('dashboard started');

      child.kill('SIGTERM');
      const code = await Promise.race([exited, sleep(10_000).then(() => 'timeout' as const)]);
      expect(code, log).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 60_000);
});
