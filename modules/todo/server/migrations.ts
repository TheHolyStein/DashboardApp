import type { Migration } from '@dash/contract';

// Column `modified_at` (not `updated_at`): the suite's migration scanner reads `UPDATE` + `d_at` as a table name.
// Never shipped before: table and index are one migration. `deleted` is the tombstone marker: a deleted item that
// came from a request keeps its row (and source_key) so the request cannot bring it back.
export const migrations: Migration[] = [
  {
    id: 1,
    up: `CREATE TABLE m_todo_items (
      id TEXT PRIMARY KEY,
      list TEXT NOT NULL,
      title TEXT NOT NULL,
      icon TEXT,
      note TEXT,
      qty TEXT,
      due TEXT,
      owner_id TEXT NOT NULL,
      assignee_id TEXT,
      visibility TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      done_by TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      source_key TEXT UNIQUE,
      url TEXT,
      repeat_every INTEGER,
      repeat_unit TEXT,
      rotation TEXT NOT NULL DEFAULT '[]',
      rotation_idx INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL
    );
    CREATE INDEX m_todo_items_list ON m_todo_items (deleted, list, done);`,
  },
];
