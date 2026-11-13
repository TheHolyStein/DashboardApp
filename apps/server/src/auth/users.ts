import { hash, verify, type Algorithm } from '@node-rs/argon2';
import type BetterSqlite3 from 'better-sqlite3';
import { DashError, type MeDto, type UserId } from '@dash/contract';
import type { z } from 'zod';
import type { CoreSeam, SessionUser } from '../seams.js';
import { uuidv7 } from '../core/ids.js';
import { deleteUserSessions } from './sessions.js';

type Prefs = z.infer<typeof MeDto>['prefs'];

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;
/** `Algorithm.Argon2id`; a const enum cannot be imported under isolatedModules. */
const ARGON2ID = 2 as Algorithm;
export const ARGON2_PARAMS = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const DEFAULT_PREFS: Prefs = { theme: 'default', modePolicy: 'system', locale: 'en', timeZone: 'UTC' };

/** Dependencies of the user functions (the CLI, the plugin and the admin API share them). */
export interface UserDeps {
  db: BetterSqlite3.Database;
  audit: CoreSeam['audit'];
  now: () => Date;
  /** Called after a user row is inserted (wired to `ensureStarterPage` by the caller). */
  onUserCreated?: ((userId: UserId) => void) | undefined;
}

export interface UserRow extends SessionUser {
  passwordHash: string;
  totpSecretEnc: string | null;
  prefs: Prefs;
  disabled: boolean;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new DashError('invalid', `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > MAX_PASSWORD) {
    throw new DashError('invalid', `Password must be at most ${MAX_PASSWORD} characters`);
  }
}

export function handleFor(name: string): string {
  const handle = name.toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{1,32}$/.test(handle)) {
    throw new DashError('invalid', 'Name must reduce to 1-32 characters of a-z, 0-9, ".", "_" or "-" (spaces ignored)');
  }
  return handle;
}

export interface CreateUserInput {
  name: string;
  password: string;
  role: 'admin' | 'member';
}

export async function createUser(deps: UserDeps, input: CreateUserInput): Promise<SessionUser> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 64) throw new DashError('invalid', 'Name must be 1-64 characters');
  if (input.role !== 'admin' && input.role !== 'member') throw new DashError('invalid', 'Role must be admin or member');
  const handle = handleFor(name);
  validatePassword(input.password);
  const taken = deps.db.prepare('SELECT 1 FROM users WHERE name = ? OR handle = ?').get(name, handle);
  if (taken) throw new DashError('conflict', 'A user with this name already exists');
  const passwordHash = await hashPassword(input.password);
  const id = uuidv7(deps.now());
  try {
    deps.db
      .prepare(
        'INSERT INTO users (id, name, handle, role, password_hash, prefs, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      )
      .run(id, name, handle, input.role, passwordHash, JSON.stringify(DEFAULT_PREFS), deps.now().toISOString());
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new DashError('conflict', 'A user with this name already exists');
    }
    throw err;
  }
  deps.onUserCreated?.(id);
  deps.audit({ userId: id, action: 'user.create', detail: { name, role: input.role } });
  return { id, name, handle, role: input.role };
}

interface DbUser {
  id: string;
  name: string;
  handle: string;
  role: 'admin' | 'member';
  password_hash: string;
  totp_secret_enc: string | null;
  prefs: string;
  disabled: number;
}

function toRow(r: DbUser): UserRow {
  return {
    id: r.id,
    name: r.name,
    handle: r.handle,
    role: r.role,
    passwordHash: r.password_hash,
    totpSecretEnc: r.totp_secret_enc,
    prefs: parsePrefs(r.prefs),
    disabled: r.disabled !== 0,
  };
}

export function parsePrefs(json: string): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(json) as Partial<Prefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function findUserByName(db: BetterSqlite3.Database, name: string): UserRow | null {
  const r = db.prepare('SELECT * FROM users WHERE name = ?').get(name) as DbUser | undefined;
  return r ? toRow(r) : null;
}

export function findUserById(db: BetterSqlite3.Database, id: UserId): UserRow | null {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUser | undefined;
  return r ? toRow(r) : null;
}

/** Enabled users, oldest first. */
export function listUsers(db: BetterSqlite3.Database): SessionUser[] {
  const rows = db
    .prepare('SELECT id, name, handle, role FROM users WHERE disabled = 0 ORDER BY created_at, id')
    .all() as SessionUser[];
  return rows;
}

/** Disables the user and ends all their sessions. */
export function disableUser(deps: UserDeps, userId: UserId): void {
  const res = deps.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId);
  if (res.changes === 0) throw new DashError('not_found', 'User not found');
  deleteUserSessions(deps.db, userId);
  deps.audit({ userId: null, action: 'user.disable', detail: { target: userId } });
}

export function updatePrefs(db: BetterSqlite3.Database, userId: UserId, patch: { [K in keyof Prefs]?: Prefs[K] | undefined }): Prefs {
  const current = findUserById(db, userId);
  if (!current) throw new DashError('not_found', 'User not found');
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next: Prefs = { ...current.prefs, ...defined };
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), userId);
  return next;
}
