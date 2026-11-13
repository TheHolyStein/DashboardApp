// Tables owned by the auth track (seams.md). Same conventions as src/core/schema.ts: timestamps are
// ISO-8601 UTC text, json columns are text, booleans are integer 0/1. The SQL lives in
// drizzle/0003_auth.sql (hand written; `name`/`handle` are COLLATE NOCASE there, which the Drizzle
// builder does not express). Queries use prepared statements; this file documents the shape.
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(), // unique, case-insensitive
  handle: text('handle').notNull(), // unique, lower-case
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: text('totp_secret_enc'), // AES-256-GCM, 'pending:' or 'active:' + base32 inside
  totpLastStep: integer('totp_last_step'), // last accepted TOTP time step (replay protection)
  prefs: text('prefs').notNull(), // json, matches MeDto.prefs
  disabled: integer('disabled').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(), // sha-256 hex of the cookie value
    userId: text('user_id').notNull(),
    csrf: text('csrf').notNull(),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    expiresAt: text('expires_at').notNull(), // absolute expiry
    ua: text('ua'),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_idx').on(t.userId, t.createdAt)],
);

export const appPasswords = sqliteTable(
  'app_passwords',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    label: text('label').notNull(),
    hash: text('hash').notNull(),
    selector: text('selector').notNull(), // first 8 characters of the password, public lookup id
    scope: text('scope').notNull(), // 'caldav'
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [index('app_passwords_user_idx').on(t.userId)],
);

export const grants = sqliteTable(
  'grants',
  {
    userId: text('user_id').notNull(),
    moduleId: text('module_id').notNull(),
    level: text('level', { enum: ['none', 'view', 'edit'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.moduleId] })],
);

export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  windowStart: text('window_start').notNull(),
  lockedUntil: text('locked_until'),
  lockLevel: integer('lock_level').notNull().default(0), // next lock lasts 15 min * 2^level (cap 24 h)
  lastFailureAt: text('last_failure_at'), // lock level decays 24 h after this
});
