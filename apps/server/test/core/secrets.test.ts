import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { DashError } from '@dash/contract';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createSecretsFactory, loadSecretKey } from '../../src/core/secrets.ts';
import type { AppConfig } from '../../src/seams.ts';

let dir: string;
let db: BetterSqlite3.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dash-a6-sec-'));
  db = openDb(':memory:');
  migrateCore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function cfg(env: AppConfig['env'], keyFile: string): AppConfig {
  return {
    dataDir: dir,
    configDir: dir,
    host: '127.0.0.1',
    port: 1,
    baseUrl: 'http://127.0.0.1:1',
    secretKeyFile: keyFile,
    env,
  };
}
async function internal(p: Promise<unknown>): Promise<DashError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(DashError);
  expect((e as DashError).code).toBe('internal');
  return e as DashError;
}

describe('host.secrets', () => {
  it('secret round-trips', async () => {
    const s = createSecretsFactory({ db, key: randomBytes(32) })('nas');
    expect(await s.get('pw')).toBeUndefined();
    await s.set('pw', 'hunter2 ü');
    expect(await s.get('pw')).toBe('hunter2 ü');
    await s.set('pw', 'second');
    expect(await s.get('pw')).toBe('second');
    await s.delete('pw');
    expect(await s.get('pw')).toBeUndefined();
    await s.delete('pw');
  });

  it('is isolated per module', async () => {
    const f = createSecretsFactory({ db, key: randomBytes(32) });
    await f('a').set('t', 'x');
    expect(await f('b').get('t')).toBeUndefined();
  });

  it('ciphertext differs for same plaintext', async () => {
    const s = createSecretsFactory({ db, key: randomBytes(32) })('nas');
    await s.set('one', 'same');
    await s.set('two', 'same');
    const rows = db.prepare('SELECT nonce, ciphertext FROM secrets ORDER BY name').all() as Array<{
      nonce: Buffer;
      ciphertext: Buffer;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.nonce.length).toBe(12);
    expect(rows[0]?.nonce.equals(rows[1]?.nonce as Buffer)).toBe(false);
    expect(rows[0]?.ciphertext.equals(rows[1]?.ciphertext as Buffer)).toBe(false);
    expect(rows[0]?.ciphertext.includes(Buffer.from('same'))).toBe(false);
  });

  it('wrong key → get throws internal, never returns garbage', async () => {
    await createSecretsFactory({ db, key: randomBytes(32) })('nas').set('pw', 'secret-value');
    const err = await internal(createSecretsFactory({ db, key: randomBytes(32) })('nas').get('pw'));
    expect(err.message).not.toContain('secret-value');
  });

  it('tampered ciphertext → internal', async () => {
    const f = createSecretsFactory({ db, key: randomBytes(32) });
    await f('nas').set('pw', 'v');
    const row = db.prepare('SELECT ciphertext FROM secrets').get() as { ciphertext: Buffer };
    const bad = Buffer.from(row.ciphertext);
    bad[0] = (bad[0] ?? 0) ^ 1;
    db.prepare('UPDATE secrets SET ciphertext = ?').run(bad);
    await internal(f('nas').get('pw'));
  });

  it('a secrets row copied to another module id fails to decrypt', async () => {
    const f = createSecretsFactory({ db, key: randomBytes(32) });
    await f('a').set('t', 'v');
    db.prepare(
      "INSERT INTO secrets (module_id, name, nonce, ciphertext) SELECT 'b', name, nonce, ciphertext FROM secrets",
    ).run();
    db.prepare(
      "INSERT INTO secrets (module_id, name, nonce, ciphertext) SELECT 'a', 'other', nonce, ciphertext FROM secrets WHERE module_id = 'a'",
    ).run();
    await internal(f('b').get('t'));
    await internal(f('a').get('other'));
    expect(await f('a').get('t')).toBe('v');
  });

  it('limits', async () => {
    const s = createSecretsFactory({ db, key: randomBytes(32) })('a');
    await s.set('n'.repeat(100), 'x'.repeat(8192));
    for (const p of [s.set('', 'x'), s.set('n'.repeat(101), 'x'), s.set('k', 'x'.repeat(8193))]) {
      await expect(p).rejects.toSatisfy(
        (e: unknown) => e instanceof DashError && e.code === 'invalid',
      );
    }
  });
});

describe('loadSecretKey', () => {
  it('key file with mode 0644 in production → startup error', () => {
    const f = path.join(dir, 'secret.key');
    writeFileSync(f, randomBytes(32));
    chmodSync(f, 0o644);
    expect(() => loadSecretKey(cfg('production', f))).toThrow(f);
  });

  it('accepts 0600 and 0640 in production, rejects other bits', () => {
    const f = path.join(dir, 'secret.key');
    const k = randomBytes(32);
    writeFileSync(f, k);
    for (const [mode, ok] of [
      [0o600, true],
      [0o640, true],
      [0o660, false],
      [0o604, false],
      [0o400, false],
    ] as const) {
      chmodSync(f, mode);
      if (ok) expect(loadSecretKey(cfg('production', f)).equals(k)).toBe(true);
      else expect(() => loadSecretKey(cfg('production', f))).toThrow();
    }
  });

  it('key file of the wrong length → error', () => {
    const f = path.join(dir, 'secret.key');
    writeFileSync(f, randomBytes(31));
    chmodSync(f, 0o600);
    for (const env of ['production', 'development', 'test'] as const) {
      expect(() => loadSecretKey(cfg(env, f))).toThrow(f);
    }
  });

  it('missing key file: error in production, created with mode 0600 in development and test', () => {
    expect(() => loadSecretKey(cfg('production', path.join(dir, 'none.key')))).toThrow();
    const f = path.join(dir, 'sub', 'dir', 'secret.key');
    const k = loadSecretKey(cfg('development', f));
    expect(k.length).toBe(32);
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f).equals(k)).toBe(true);
    expect(loadSecretKey(cfg('development', f)).equals(k)).toBe(true);
    expect(loadSecretKey(cfg('test', path.join(dir, 't', 'k'))).length).toBe(32);
  });
});
