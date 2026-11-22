import type { Migration } from '@dash/contract';

// Never shipped before: table and index are one migration. `deleted` is the tombstone marker: a deleted item that
// came from a request keeps its row (and source_key) so the request cannot bring it back. `source_key` is unique per
// owner, so two users' requests never collide. `spawned_id` is the next occurrence a done chore created; `request_json`
// the last request payload (title, due, assignee) so a re-emitted request only changes what the request changed;
// `anchor_day` the day of month a monthly chore keeps.
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
      source_key TEXT,
      url TEXT,
      repeat_every INTEGER,
      repeat_unit TEXT,
      rotation TEXT NOT NULL DEFAULT '[]',
      rotation_idx INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      spawned_id TEXT,
      anchor_day INTEGER,
      request_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, source_key)
    );
    CREATE INDEX m_todo_items_list ON m_todo_items (deleted, list, done);`,
  },
];
