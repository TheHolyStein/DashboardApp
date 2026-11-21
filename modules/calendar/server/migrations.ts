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
  {
    id: 2,
    // One row per component of a resource (the master, and each overridden instance), all holding the resource's
    // full ICS. `recurrence_id` is '' for the master. `dtstart_utc` / `dtend_utc` are ISO instants (all-day: midnight
    // UTC of the date); `until_utc` is when the series ends (a single event: its end), NULL when it never does.
    up: `CREATE TABLE m_calendar_events (
        uid TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        recurrence_id TEXT NOT NULL DEFAULT '',
        ics TEXT NOT NULL,
        etag TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        dtstart_utc TEXT NOT NULL,
        dtend_utc TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        tzid TEXT NOT NULL DEFAULT '',
        has_rrule INTEGER NOT NULL DEFAULT 0,
        until_utc TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        mentions TEXT NOT NULL DEFAULT '[]',
        is_private INTEGER NOT NULL DEFAULT 0,
        creator_id TEXT NOT NULL,
        modified_at TEXT NOT NULL, -- plan: updated_at (renamed: the contract suite's table-name scan reads it as UPDATE d_at)
        PRIMARY KEY (calendar_id, uid, recurrence_id)
      );
      CREATE INDEX m_calendar_events_range ON m_calendar_events (calendar_id, dtstart_utc);
      CREATE TABLE m_calendar_changes (
        calendar_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        uid TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL,
        PRIMARY KEY (calendar_id, seq)
      );`,
  },
];
