import { readFileSync } from 'node:fs';
import type { StoredEvent } from '../server/events-repo.js';

export function fixture(name: string): string {
  return readFileSync(`${import.meta.dirname}/../fixtures/${name}.ics`, 'utf8');
}

/** A StoredEvent for `expand` tests that does not need a database: only calendarId, uid and ics matter to it. */
export function stored(ics: string, uid: string, calendarId = 'cal-1'): StoredEvent {
  return {
    calendar_id: calendarId,
    uid,
    recurrence_id: '',
    ics,
    etag: '',
    summary: '',
    description: '',
    location: '',
    dtstart_utc: '',
    dtend_utc: '',
    all_day: 0,
    tzid: '',
    has_rrule: 0,
    until_utc: null,
    tags: '[]',
    mentions: '[]',
    is_private: 0,
    creator_id: '',
    modified_at: '',
  };
}

export const ISO = (ms: number): string => new Date(ms).toISOString();
