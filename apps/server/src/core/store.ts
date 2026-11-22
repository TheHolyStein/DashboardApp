// host.store: per-module key-value (table `kv`, JSON values) and blobs (files).
// Blob layout: <dataDir>/blobs/<moduleId>/<sha256 hex of key>  (data, mode 0600)
//              <dataDir>/blobs/<moduleId>/<sha256 hex of key>.meta  (sidecar JSON {contentType}, mode 0600)
// The key never becomes part of a path. Metadata lives in a sidecar file (not in kv) so `keys()` can never
// expose it. Writes are atomic: temp file in the same directory, fsync, rename; data first, then meta.
// A blob exists only when both files are present.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, chmod, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { DashError, type ModuleId } from '@dash/contract';
import type { StoreFactory } from './modules/deps.js';

const MAX_KEY = 200;
const MAX_KV_BYTES = 256 * 1024;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_MODULE_BLOB_BYTES = 500 * 1024 * 1024;
const MAX_CONTENT_TYPE = 100;
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const DATA_FILE = /^[0-9a-f]{64}$/;

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY) {
    throw new DashError('invalid', `Key must be 1-${MAX_KEY} characters`);
  }
}

async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Runs sync work so that thrown errors become rejections. */
function attempt<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(fn());
  });
}

async function sizeOrZero(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export function createStoreFactory(deps: {
  db: BetterSqlite3.Database;
  dataDir: string;
}): StoreFactory {
  const { db, dataDir } = deps;
  const getStmt = db.prepare('SELECT value FROM kv WHERE module_id = ? AND key = ?');
  const setStmt = db.prepare(
    `INSERT INTO kv (module_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (module_id, key) DO UPDATE SET value = excluded.value`,
  );
  const delStmt = db.prepare('DELETE FROM kv WHERE module_id = ? AND key = ?');
  // substr comparison instead of LIKE: literal and case-sensitive, no wildcard escaping needed.
  const keysStmt = db.prepare(
    'SELECT key FROM kv WHERE module_id = ? AND substr(key, 1, length(?)) = ? ORDER BY key',
  );
  const locks = new Map<ModuleId, Promise<unknown>>();

  /** Serialises blob writes of one module so the quota check and the write are not interleaved. */
  function exclusive<T>(moduleId: ModuleId, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(moduleId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(moduleId, tail);
    void tail.then(() => {
      if (locks.get(moduleId) === tail) locks.delete(moduleId);
    });
    return run;
  }

  return (moduleId) => {
    const modDir = path.join(dataDir, 'blobs', moduleId);
    const fileFor = (key: string): string =>
      path.join(modDir, createHash('sha256').update(key, 'utf8').digest('hex'));

    async function ensureDir(): Promise<void> {
      await mkdir(modDir, { recursive: true, mode: 0o700 });
      await chmod(modDir, 0o700);
    }

    async function usedBytes(): Promise<number> {
      let names: string[];
      try {
        names = await readdir(modDir);
      } catch {
        return 0;
      }
      let total = 0;
      for (const n of names) if (DATA_FILE.test(n)) total += await sizeOrZero(path.join(modDir, n));
      return total;
    }

    return {
      get<T>(key: string): Promise<T | undefined> {
        return attempt(() => {
          checkKey(key);
          const row = getStmt.get(moduleId, key) as { value: string } | undefined;
          return row ? (JSON.parse(row.value) as T) : undefined;
        });
      },
      set: (key, value) =>
        attempt(() => {
          checkKey(key);
          if (value === undefined)
            throw new DashError('invalid', 'Value must not be undefined; use delete()');
          const json = JSON.stringify(value) as string | undefined;
          if (json === undefined) throw new DashError('invalid', 'Value is not JSON-serialisable');
          if (Buffer.byteLength(json, 'utf8') > MAX_KV_BYTES) {
            throw new DashError('invalid', `Value exceeds ${MAX_KV_BYTES / 1024} KB`);
          }
          setStmt.run(moduleId, key, json);
        }),
      delete: (key) =>
        attempt(() => {
          checkKey(key);
          delStmt.run(moduleId, key);
        }),
      keys: (prefix = '') =>
        attempt(() => {
          const rows = keysStmt.all(moduleId, prefix, prefix) as Array<{ key: string }>;
          return rows.map((r) => r.key);
        }),
      blob: {
        async put(key, data, contentType) {
          checkKey(key);
          if (
            typeof contentType !== 'string' ||
            contentType.length > MAX_CONTENT_TYPE ||
            !CONTENT_TYPE.test(contentType)
          ) {
            throw new DashError(
              'invalid',
              'Content type must look like type/subtype (at most 100 characters)',
            );
          }
          if (data.byteLength > MAX_BLOB_BYTES) {
            throw new DashError('invalid', `Blob exceeds ${MAX_BLOB_BYTES / (1024 * 1024)} MB`);
          }
          await exclusive(moduleId, async () => {
            await ensureDir();
            const file = fileFor(key);
            const freed = await sizeOrZero(file);
            if ((await usedBytes()) - freed + data.byteLength > MAX_MODULE_BLOB_BYTES) {
              throw new DashError(
                'invalid',
                `Module blob storage exceeds ${MAX_MODULE_BLOB_BYTES / (1024 * 1024)} MB`,
              );
            }
            await writeAtomic(file, data);
            await writeAtomic(`${file}.meta`, JSON.stringify({ contentType }));
          });
        },
        async get(key) {
          checkKey(key);
          const file = fileFor(key);
          try {
            const meta = JSON.parse(await readFile(`${file}.meta`, 'utf8')) as {
              contentType: string;
            };
            const data = await readFile(file);
            return {
              data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
              contentType: meta.contentType,
            };
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw e;
          }
        },
        async delete(key) {
          checkKey(key);
          const file = fileFor(key);
          await exclusive(moduleId, async () => {
            await rm(`${file}.meta`, { force: true });
            await rm(file, { force: true });
          });
        },
      },
    };
  };
}
