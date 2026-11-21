import ICAL from 'ical.js';
import { DashError } from '@dash/contract';
import {
  intlVTimezone,
  isIanaZone,
  utcToWall,
  wallMsOf,
  wallToUtc,
  type Zone,
} from './zones.js';

/**
 * Event shape used by the API and by `toVEvent`.
 *
 * `start` / `end` are local wall-clock strings in `timeZone`: `YYYY-MM-DDTHH:mm:ss` for timed events and
 * `YYYY-MM-DD` for all-day events (where `end` is exclusive, as DTEND is in ICS). `timeZone` is an IANA name, `UTC`,
 * or `floating` (no zone: the same wall clock everywhere; used for all-day events and zone-less imports).
 * `exdates` use the same wall-clock form as `start`.
 */
export interface EventInput {
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  rrule?: string | null;
  exdates?: string[];
}

export interface ParsedEvent {
  uid: string;
  /** '' for the master; for an override the original start of the instance (UTC `…Z`, or a date for all-day). */
  recurrenceId: string;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  rrule: string | null;
  exdates: string[];
}

/** A component of a parsed resource with everything the index and the expander need. */
export interface ResourceEvent {
  parsed: ParsedEvent;
  zone: Zone;
  /** UTC epoch ms (all-day: midnight UTC of the date). */
  startMs: number;
  endMs: number;
  cancelled: boolean;
  isPrivate: boolean;
  /** Master with RRULE or RDATE. */
  recurring: boolean;
  vevent: ICAL.Component;
  dtstart: ICAL.Time;
}

export interface Resource {
  uid: string;
  events: ResourceEvent[];
}

type JCal = [string, unknown[], unknown[]];

function parseComponent(text: string): ICAL.Component {
  const jcal: unknown = ICAL.parse(text);
  return new ICAL.Component(jcal as JCal);
}

const DAY_MS = 86_400_000;
const MAX_ICS_BYTES = 1_000_000;

function invalid(message: string): DashError {
  return new DashError('invalid', message);
}

export function wallString(wallMs: number, allDay: boolean): string {
  const iso = new Date(wallMs).toISOString();
  return allDay ? iso.slice(0, 10) : iso.slice(0, 19);
}

/** Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss` into wall ms; throws invalid. */
export function parseWall(text: string, allDay: boolean): number {
  const m = allDay
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) throw invalid(`bad ${allDay ? 'date' : 'date-time'} "${text}"`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as [
    number, number, number, number, number, number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (wallString(ms, allDay) !== text) throw invalid(`bad ${allDay ? 'date' : 'date-time'} "${text}"`);
  return ms;
}

function zoneName(zone: Zone): string {
  if (zone.tzid === 'UTC' || zone.tzid === 'Z') return 'UTC';
  if (zone.tzid === 'floating' || !zone.tzid) return 'floating';
  return zone.tzid;
}

function timeWall(t: ICAL.Time): number {
  return wallMsOf({ year: t.year, month: t.month, day: t.day, hour: t.isDate ? 0 : t.hour, minute: t.isDate ? 0 : t.minute, second: t.isDate ? 0 : t.second });
}

/** Years mentioned by date-times in the text, widened by one on both sides. */
function yearSpan(ics: string): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of ics.matchAll(/(?:^|[:;=,])(\d{4})[01]\d[0-3]\d(?:T[0-2]\d[0-5]\d[0-6]\dZ?)?(?=$|[,;\r\n])/gm)) {
    const y = Number(m[1]);
    if (y < 1900 || y > 2200) continue;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return lo > hi ? [2000, 2040] : [lo - 1, hi + 1];
}

/** Date-time properties of a VEVENT that may carry a TZID. */
function tzidsOf(root: ICAL.Component): Set<string> {
  const out = new Set<string>();
  for (const ve of root.getAllSubcomponents('vevent')) {
    for (const prop of ve.getAllProperties()) {
      const tzid = prop.getParameter('tzid');
      if (typeof tzid === 'string' && tzid) out.add(tzid);
    }
  }
  return out;
}

function parseRoot(ics: string, toYear?: number): ICAL.Component {
  if (typeof ics !== 'string' || ics.trim() === '') throw invalid('empty calendar data');
  if (ics.length > MAX_ICS_BYTES) throw invalid('calendar data is too large');
  let root: ICAL.Component;
  try {
    root = parseComponent(ics);
  } catch (e) {
    throw invalid(`malformed calendar data: ${e instanceof Error ? e.message : 'parse error'}`);
  }
  if (root.name !== 'vcalendar') throw invalid('not a VCALENDAR');

  // Zones the file does not define come from the IANA data of the runtime.
  const [lo, hi] = yearSpan(ics);
  for (const tzid of tzidsOf(root)) {
    if (root.getTimeZoneByID(tzid)) continue;
    if (!isIanaZone(tzid)) throw invalid(`unknown time zone "${tzid}" and the file does not define it`);
    const text = intlVTimezone(tzid, lo, Math.max(hi, toYear ?? hi), false);
    root.addSubcomponent(parseComponent(text));
  }
  return root;
}

function requireTime(prop: ICAL.Property | null, what: string): ICAL.Time {
  const value: unknown = prop?.getFirstValue();
  if (!(value instanceof ICAL.Time)) throw invalid(`missing or bad ${what}`);
  return value;
}

function recurrenceKey(t: ICAL.Time): string {
  if (t.isDate) return wallString(timeWall(t), true);
  const utc = wallToUtc(t.zone, timeWall(t));
  return `${new Date(utc).toISOString().slice(0, 19)}Z`;
}

function toMs(t: ICAL.Time): number {
  return t.isDate ? timeWall(t) : wallToUtc(t.zone, timeWall(t));
}

function readEvent(ve: ICAL.Component): ResourceEvent {
  const uid = ve.getFirstPropertyValue('uid');
  if (typeof uid !== 'string' || uid === '') throw invalid('VEVENT without UID');
  const dtstart = requireTime(ve.getFirstProperty('dtstart'), 'DTSTART');
  const allDay = dtstart.isDate;
  const zone = dtstart.zone;
  const startMs = toMs(dtstart);

  let endMs: number;
  const dtendProp = ve.getFirstProperty('dtend');
  const durationProp = ve.getFirstProperty('duration');
  if (dtendProp) {
    const dtend = requireTime(dtendProp, 'DTEND');
    if (dtend.isDate !== allDay) throw invalid('DTSTART and DTEND must both be dates or both be date-times');
    endMs = toMs(dtend);
  } else if (durationProp) {
    const d: unknown = durationProp.getFirstValue();
    if (!(d instanceof ICAL.Duration)) throw invalid('bad DURATION');
    endMs = startMs + d.toSeconds() * 1000;
  } else {
    endMs = allDay ? startMs + DAY_MS : startMs;
  }
  if (endMs < startMs) throw invalid('the event ends before it starts');

  const startWall = timeWall(dtstart);
  const endWall = allDay ? endMs : utcToWall(zone, endMs);

  const exdates: string[] = [];
  for (const prop of ve.getAllProperties('exdate')) {
    for (const v of prop.getValues() as unknown[]) {
      if (!(v instanceof ICAL.Time)) throw invalid('bad EXDATE');
      if (allDay) exdates.push(wallString(timeWall(v), true));
      else if (v.isDate) exdates.push(wallString(timeWall(v) + (startWall % DAY_MS), false));
      else exdates.push(wallString(utcToWall(zone, wallToUtc(v.zone, timeWall(v))), false));
    }
  }

  const rruleValue: unknown = ve.getFirstPropertyValue('rrule');
  let rrule: string | null = null;
  if (rruleValue !== null && rruleValue !== undefined) {
    if (!(rruleValue instanceof ICAL.Recur) || !rruleValue.freq) throw invalid('bad RRULE');
    rrule = rruleValue.toString();
  }
  const hasRdate = ve.hasProperty('rdate');

  const recurrenceIdProp = ve.getFirstProperty('recurrence-id');
  const recurrenceId = recurrenceIdProp ? recurrenceKey(requireTime(recurrenceIdProp, 'RECURRENCE-ID')) : '';

  const text = (name: string): string => {
    const v: unknown = ve.getFirstPropertyValue(name);
    return typeof v === 'string' ? v : '';
  };
  const status = text('status').toUpperCase();
  const klass = text('class').toUpperCase();

  return {
    parsed: {
      uid,
      recurrenceId,
      title: text('summary'),
      description: text('description'),
      location: text('location'),
      start: wallString(startWall, allDay),
      end: wallString(endWall, allDay),
      allDay,
      timeZone: allDay ? 'floating' : zoneName(zone),
      rrule,
      exdates,
    },
    zone,
    startMs,
    endMs,
    cancelled: status === 'CANCELLED',
    isPrivate: klass === 'PRIVATE' || klass === 'CONFIDENTIAL',
    recurring: recurrenceId === '' && (rrule !== null || hasRdate),
    vevent: ve,
    dtstart,
  };
}

/**
 * Reads one calendar resource (an ICS file about one UID: a master and/or overridden instances).
 * Throws DashError('invalid') for anything that is not one. `toYear` widens the zone tables built from IANA data
 * so that recurrence can be expanded that far.
 */
export function readResource(ics: string, opts: { toYear?: number } = {}): Resource {
  const root = parseRoot(ics, opts.toYear);
  const vevents = root.getAllSubcomponents('vevent');
  if (vevents.length === 0) throw invalid('no VEVENT in the calendar data');
  const events: ResourceEvent[] = [];
  const seen = new Set<string>();
  try {
    for (const ve of vevents) {
      const ev = readEvent(ve);
      if (seen.has(ev.parsed.recurrenceId)) throw invalid('two components with the same UID and RECURRENCE-ID');
      seen.add(ev.parsed.recurrenceId);
      events.push(ev);
    }
  } catch (e) {
    if (e instanceof DashError) throw e;
    throw invalid(`malformed event: ${e instanceof Error ? e.message : 'error'}`);
  }
  const uid = events[0]!.parsed.uid;
  if (events.some((e) => e.parsed.uid !== uid)) throw invalid('one resource must hold exactly one UID');
  return { uid, events };
}

/** Master and overrides of one resource as plain data. Throws DashError('invalid'). */
export function fromVCalendar(ics: string): ParsedEvent[] {
  return readResource(ics).events.map((e) => e.parsed);
}

/** A full VCALENDAR (VERSION, PRODID, VTIMEZONE when needed, one VEVENT). */
export function toVEvent(input: EventInput, uid: string, now: Date): string {
  const allDay = input.allDay;
  const tzid = input.timeZone;
  const named = !allDay && tzid !== 'UTC' && tzid !== 'floating';
  if (named && !isIanaZone(tzid)) throw invalid(`unknown time zone "${tzid}"`);
  if (!uid) throw invalid('missing uid');

  const startWall = parseWall(input.start, allDay);
  const endWall = parseWall(input.end, allDay);
  if (endWall < startWall) throw invalid('the event ends before it starts');
  const exWalls = (input.exdates ?? []).map((d) => parseWall(d, allDay));

  const vcal = new ICAL.Component('vcalendar');
  vcal.addPropertyWithValue('version', '2.0');
  vcal.addPropertyWithValue('prodid', '-//Home Dashboard//Calendar//EN');

  if (named) {
    const year = new Date(startWall).getUTCFullYear();
    vcal.addSubcomponent(parseComponent(intlVTimezone(tzid, year - 2, year + 2, true)));
  }

  // Time value with the zone's TZID parameter written explicitly (a Time's own zone object is not enough for ical.js).
  const timeProp = (name: string, wall: number): ICAL.Property => {
    const d = new Date(wall);
    const t = new ICAL.Time(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: allDay ? 0 : d.getUTCHours(),
        minute: allDay ? 0 : d.getUTCMinutes(),
        second: allDay ? 0 : d.getUTCSeconds(),
        isDate: allDay,
      },
      !allDay && tzid === 'UTC' ? ICAL.Timezone.utcTimezone : ICAL.Timezone.localTimezone,
    );
    const prop = new ICAL.Property(name);
    prop.setValue(t);
    if (named) prop.setParameter('tzid', tzid);
    return prop;
  };

  const ve = new ICAL.Component('vevent');
  ve.addPropertyWithValue('uid', uid);
  ve.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(now, true));
  ve.addProperty(timeProp('dtstart', startWall));
  ve.addProperty(timeProp('dtend', endWall));
  ve.addPropertyWithValue('summary', input.title);
  if (input.description) ve.addPropertyWithValue('description', input.description);
  if (input.location) ve.addPropertyWithValue('location', input.location);
  if (input.rrule) {
    let recur: ICAL.Recur;
    try {
      recur = ICAL.Recur.fromString(input.rrule.replace(/^RRULE:/i, ''));
    } catch {
      throw invalid(`bad RRULE "${input.rrule}"`);
    }
    if (!recur.freq) throw invalid(`bad RRULE "${input.rrule}"`);
    ve.addPropertyWithValue('rrule', recur);
  }
  for (const wall of exWalls) ve.addProperty(timeProp('exdate', wall));
  vcal.addSubcomponent(ve);
  return vcal.toString();
}

