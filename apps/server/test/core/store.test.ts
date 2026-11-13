import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { DashError } from '@dash/contract';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createStoreFactory } from '../../src/core/store.ts';

let dir: string;
let db: BetterSqlite3.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dash-a6-store-'));
  db = openDb(path.join(dir, 'test.db'));
  migrateCore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);
async function invalid(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DashError && e.code === 'invalid');
}

describe('host.store', () => {
  it('kv is isolated per module', async () => {
    const f = createStoreFactory({ db, dataDir: dir });
    const a = f('mod-a');
    const b = f('mod-b');
    await a.set('k', { n: 1 });
    expect(await a.get('k')).toEqual({ n: 1 });
    expect(await b.get('k')).toBeUndefined();
    await b.set('k', 'other');
    await a.delete('k');
    expect(await b.get('k')).toBe('other');
    expect(await b.keys()).toEqual(['k']);
    expect(await a.keys()).toEqual([]);
  });

  it('keys(prefix) filters', async () => {
    const s = createStoreFactory({ db, dataDir: dir })('mod-a');
    for (const k of ['b2', 'a1', 'a2', 'c']) await s.set(k, 1);
    expect(await s.keys('a')).toEqual(['a1', 'a2']);
    expect(await s.keys()).toEqual(['a1', 'a2', 'b2', 'c']);
  });

  it('keys(prefix) matches literally', async () => {
    const s = createStoreFactory({ db, dataDir: dir })('mod-a');
    for (const k of ['a_1', 'ab', 'a%x', 'axx', 'A_up']) await s.set(k, 1);
    expect(await s.keys('a_')).toEqual(['a_1']);
    expect(await s.keys('a%')).toEqual(['a%x']);
  });

  it('values over 256 KB rejected', async () => {
    const s = createStoreFactory({ db, dataDir: dir })('mod-a');
    await invalid(s.set('big', 'x'.repeat(256 * 1024)));
    await s.set('ok', 'x'.repeat(256 * 1024 - 2));
    await invalid(s.set('u', undefined));
    await invalid(s.set('', 1));
    await invalid(s.set('k'.repeat(201), 1));
  });

  it('blob round-trips and is isolated per module', async () => {
    const f = createStoreFactory({ db, dataDir: dir });
    const a = f('mod-a');
    const b = f('mod-b');
    await a.blob.put('img', Uint8Array.from([1, 2, 3]), 'image/png');
    const got = await a.blob.get('img');
    expect(got?.contentType).toBe('image/png');
    expect(Array.from(got?.data ?? [])).toEqual([1, 2, 3]);
    expect(await b.blob.get('img')).toBeUndefined();
    await b.blob.delete('img');
    expect(await a.blob.get('img')).toBeDefined();
    await a.blob.delete('img');
    expect(await a.blob.get('img')).toBeUndefined();
    await a.blob.delete('img');
  });

  it('blob over 10 MB rejected', async () => {
    const s = createStoreFactory({ db, dataDir: dir })('mod-a');
    await invalid(s.blob.put('big', bytes(10 * 1024 * 1024 + 1), 'application/octet-stream'));
    await s.blob.put('max', bytes(10 * 1024 * 1024), 'application/octet-stream');
  });

  it('blob key cannot escape the module directory ("../x")', async () => {
    const f = createStoreFactory({ db, dataDir: dir });
    const a = f('mod-a');
    await a.blob.put('../x', Uint8Array.from([9]), 'text/plain');
    const modDir = path.join(dir, 'blobs', 'mod-a');
    const files = readdirSync(modDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((n) => /^[0-9a-f]{64}(\.meta)?$/.test(n))).toBe(true);
    expect(existsSync(path.join(dir, 'blobs', 'x'))).toBe(false);
    expect(existsSync(path.join(dir, 'x'))).toBe(false);
    expect(readdirSync(path.join(dir, 'blobs'))).toEqual(['mod-a']);
    expect(await f('mod-b').blob.get('../x')).toBeUndefined();
    expect(await a.blob.get('../x')).toBeDefined();
  });

  it('blob modes and content type validation', async () => {
    const s = createStoreFactory({ db, dataDir: dir })('mod-a');
    await s.blob.put('k', bytes(1), 'text/plain');
    const modDir = path.join(dir, 'blobs', 'mod-a');
    expect(statSync(modDir).mode & 0o777).toBe(0o700);
    for (const n of readdirSync(modDir))
      expect(statSync(path.join(modDir, n)).mode & 0o777).toBe(0o600);
    await invalid(s.blob.put('k', bytes(1), 'plain'));
    await invalid(s.blob.put('k', bytes(1), 'text/' + 'a'.repeat(100)));
    await invalid(s.blob.put('', bytes(1), 'text/plain'));
    expect(readdirSync(modDir).some((n) => n.includes('.tmp'))).toBe(false);
  });

  it('replacing a blob frees its old size against the module quota', async () => {
    const f = createStoreFactory({ db, dataDir: dir });
    const s = f('mod-a');
    const mb10 = bytes(10 * 1024 * 1024);
    for (let i = 0; i < 50; i++) await s.blob.put(`b${i}`, mb10, 'application/octet-stream');
    await invalid(s.blob.put('extra', bytes(1), 'application/octet-stream'));
    await s.blob.put('b0', mb10, 'application/octet-stream'); // replace: old size is freed
    await s.blob.delete('b1');
    await s.blob.put('extra', bytes(1), 'application/octet-stream');
    await f('mod-b').blob.put('x', mb10, 'text/plain'); // own quota
  }, 60_000);
});
