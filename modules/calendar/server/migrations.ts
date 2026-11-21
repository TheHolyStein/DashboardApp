import type { Migration } from '@dash/contract';

/** Ids ascend from 1; never edit a shipped migration. */
export const migrations: Migration[] = [
  {
    id: 1,
    // m_calendar_personal records, once per user, that "Personal" was created: it is the race-safe,
    // delete-proof marker (a deleted Personal calendar does not come back).
    up: `CREATE TABLE m_calendar_calendars (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'subscription')),
        source_url TEXT,
        sync_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX m_calendar_calendars_owner ON m_calendar_calendars (owner_id, created_at);
      CREATE TABLE m_calendar_shares (
        calendar_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
        PRIMARY KEY (calendar_id, user_id)
      );
      CREATE INDEX m_calendar_shares_user ON m_calendar_shares (user_id);
      CREATE TABLE m_calendar_personal (
        user_id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL
      );`,
  },
];
