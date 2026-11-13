// host.secrets: AES-256-GCM per value, key read once from the key file. Each ciphertext is bound to its
// row through additional authenticated data `<moduleId>\0<name>`, so copying a row to another module or
// name makes it undecryptable. Failure messages are generic: no key material, no plaintext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { DashError } from '@dash/contract';
import type { AppConfig } from '../seams.js';
import type { SecretsFactory } from './modules/deps.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_NAME = 100;
const MAX_VALUE_BYTES = 8 * 1024;

/**
 * Reads the 32-byte key once. Production: the file must exist with mode 0600 or 0640 (group read is for
 * root:dashboard); any other permission bit is an error. Development/test: a missing file is created with
 * 32 random bytes, mode 0600. A wrong length is always an error. Messages name the path, never content.
 */
/** Runs sync work so that thrown errors become rejections. */
function attempt<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(fn());
  });
}

export function loadSecretKey(config: AppConfig): Buffer {
  const file = config.secretKeyFile;
  if (!existsSync(file)) {
    if (config.env === 'production') {
      throw new Error(`Secret key file ${file} does not exist`);
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeSync(fd, randomBytes(KEY_BYTES));
    } finally {
      closeSync(fd);
    }
    chmodSync(file, 0o600); // umask-proof
  }
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`Secret key file ${file} is not a regular file`);
  if (config.env === 'production') {
    const mode = st.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o640) {
      throw new Error(
        `Secret key file ${file} has mode ${mode.toString(8).padStart(4, '0')}; it must be 0600 or 0640`,
      );
    }
  }
  const key = readFileSync(file);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Secret key file ${file} must contain exactly ${KEY_BYTES} bytes (found ${key.length})`,
    );
  }
  return key;
}

export function createSecretsFactory(deps: {
  db: BetterSqlite3.Database;
  key: Buffer;
}): SecretsFactory {
  const { db } = deps;
  if (deps.key.length !== KEY_BYTES) throw new Error(`Secret key must be ${KEY_BYTES} bytes`);
  const key = Buffer.from(deps.key); // private copy
  const selectStmt = db.prepare(
    'SELECT nonce, ciphertext FROM secrets WHERE module_id = ? AND name = ?',
  );
  const upsertStmt = db.prepare(
    `INSERT INTO secrets (module_id, name, nonce, ciphertext) VALUES (?, ?, ?, ?)
     ON CONFLICT (module_id, name) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext`,
  );
  const deleteStmt = db.prepare('DELETE FROM secrets WHERE module_id = ? AND name = ?');

  const aad = (moduleId: string, name: string): Buffer =>
    Buffer.from(`${moduleId}\0${name}`, 'utf8');
  const checkName = (name: string): void => {
    if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME) {
      throw new DashError('invalid', `Secret name must be 1-${MAX_NAME} characters`);
    }
  };

  return (moduleId) => ({
    get: (name) =>
      attempt(() => {
        checkName(name);
        const row = selectStmt.get(moduleId, name) as
          { nonce: Buffer; ciphertext: Buffer } | undefined;
        if (!row) return undefined;
        try {
          if (row.nonce.length !== NONCE_BYTES || row.ciphertext.length < TAG_BYTES)
            throw new Error('shape');
          const body = row.ciphertext.subarray(0, row.ciphertext.length - TAG_BYTES);
          const tag = row.ciphertext.subarray(row.ciphertext.length - TAG_BYTES);
          const d = createDecipheriv('aes-256-gcm', key, row.nonce);
          d.setAAD(aad(moduleId, name));
          d.setAuthTag(tag);
          return Buffer.concat([d.update(body), d.final()]).toString('utf8');
        } catch {
          throw new DashError('internal', 'Secret could not be decrypted');
        }
      }),
    set: (name, value) =>
      attempt(() => {
        checkName(name);
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
          throw new DashError(
            'invalid',
            `Secret value must be a string of at most ${MAX_VALUE_BYTES} bytes`,
          );
        }
        const nonce = randomBytes(NONCE_BYTES);
        const c = createCipheriv('aes-256-gcm', key, nonce);
        c.setAAD(aad(moduleId, name));
        const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
        upsertStmt.run(moduleId, name, nonce, Buffer.concat([body, c.getAuthTag()]));
      }),
    delete: (name) =>
      attempt(() => {
        checkName(name);
        deleteStmt.run(moduleId, name);
      }),
  });
}
