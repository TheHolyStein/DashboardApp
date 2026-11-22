// Core tables owned by track A (see seams.md). Tables owned by track B live in src/auth/schema.ts.
// Conventions: timestamps are ISO-8601 UTC text (e.g. 2026-11-12T10:00:00.000Z, lexicographically sortable);
// json columns are text holding JSON.stringify output; booleans are integer 0/1.
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    userId: text('user_id'),
    action: text('action').notNull(),
    detail: text('detail'), // json
    ip: text('ip'),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_user_idx').on(t.userId)],
);

export const pages = sqliteTable(
  'pages',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    shared: integer('shared').notNull().default(0),
    background: text('background'),
  },
  (t) => [index('pages_owner_idx').on(t.ownerId, t.sort)],
);

export const instances = sqliteTable(
  'instances',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id').notNull(),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    settings: text('settings').notNull().default('{}'), // json
    x: integer('x').notNull().default(0),
    y: integer('y').notNull().default(0),
    w: integer('w').notNull().default(1),
    h: integer('h').notNull().default(1),
    mobileOrder: integer('mobile_order').notNull().default(0),
  },
  (t) => [index('instances_page_idx').on(t.pageId), index('instances_module_idx').on(t.moduleId)],
);

// instance_id is nullable (module-wide snapshot). SQLite treats NULLs as distinct in unique
// indexes, so the "one snapshot per module+instance" index (coalesce(instance_id, '')) lives in
// the hand-written migration 0001_snapshots_unique.sql; drizzle-kit cannot express it.
export const snapshots = sqliteTable('snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  moduleId: text('module_id').notNull(),
  instanceId: text('instance_id'),
  data: text('data').notNull(), // json
  updatedAt: text('updated_at').notNull(),
  jobOk: integer('job_ok').notNull().default(1),
});

export const kv = sqliteTable(
  'kv',
  {
    moduleId: text('module_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(), // json
  },
  (t) => [primaryKey({ columns: [t.moduleId, t.key] })],
);

export const secrets = sqliteTable(
  'secrets',
  {
    moduleId: text('module_id').notNull(),
    name: text('name').notNull(),
    nonce: blob('nonce', { mode: 'buffer' }).notNull(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.moduleId, t.name] })],
);

export const moduleState = sqliteTable('module_state', {
  moduleId: text('module_id').primaryKey(),
  enabled: integer('enabled').notNull().default(1),
  config: text('config').notNull().default('{}'), // json
  migrationId: integer('migration_id').notNull().default(0),
});

// instance_id is '' for jobs that are not per-instance (part of the primary key, so not nullable).
export const jobState = sqliteTable(
  'job_state',
  {
    moduleId: text('module_id').notNull(),
    job: text('job').notNull(),
    instanceId: text('instance_id').notNull().default(''),
    lastRunAt: text('last_run_at'),
    lastOkAt: text('last_ok_at'),
    failures: integer('failures').notNull().default(0),
    nextRunAt: text('next_run_at'),
  },
  (t) => [
    primaryKey({ columns: [t.moduleId, t.job, t.instanceId] }),
    index('job_state_next_idx').on(t.nextRunAt),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id').notNull(),
    userId: text('user_id'), // null = visible to all users
    level: text('level').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    titleKey: text('title_key'), // migration 0006: translation keys + JSON vars; title/body stay the English fallback
    bodyKey: text('body_key'),
    vars: text('vars'),
    url: text('url'),
    dedupeKey: text('dedupe_key'),
    createdAt: text('created_at').notNull(),
    readAt: text('read_at'),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_dedupe_idx').on(t.moduleId, t.dedupeKey),
  ],
);

// until: ISO-8601 UTC time or the literal 'forever'. Migration 0002_notification_mutes.sql.
export const notificationMutes = sqliteTable(
  'notification_mutes',
  {
    userId: text('user_id').notNull(),
    moduleId: text('module_id').notNull(),
    until: text('until').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.moduleId] })],
);

export const httpCache = sqliteTable(
  'http_cache',
  {
    key: text('key').primaryKey(),
    status: integer('status').notNull(),
    headers: text('headers').notNull().default('{}'), // json
    body: blob('body', { mode: 'buffer' }),
    expiresAt: text('expires_at').notNull(),
    etag: text('etag'),
  },
  (t) => [index('http_cache_expires_idx').on(t.expiresAt)],
);
