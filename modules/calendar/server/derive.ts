import { createHash } from 'node:crypto';
import type { EventName, HostServices, ModuleDb } from '@dash/contract';
import type { Config } from '../manifest.js';
import { displayTitle, parseCommands } from './commands/parse.js';
import { commands } from './commands/registry.js';
import type { CommandUser, Derived } from './commands/types.js';
import { rowsInRange } from './dto.js';
import { expand, type Occurrence } from './recurrence.js';

const DAY_MS = 86_400_000;

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

interface Wanted {
  derived: Exclude<Derived, { kind: 'flag' }>;
  calendarId: string;
  uid: string;
  occurrence: string;
  title: string;
  hash: string;
}

interface DerivedRow {
  source_key: string;
  calendar_id: string;
  uid: string;
  occurrence: string;
  kind: string;
  payload_hash: string;
  remove_json: string | null;
}

type Publish = { name: EventName; payload: unknown };

/** The derived items of one occurrence (flags left out: they live on the event itself). */
export function deriveOccurrence(
  o: Occurrence,
  ctx: { users: CommandUser[]; creatorId: string; defaultReminderMin: number },
): Wanted[] {
  const handles = ctx.users.map((u) => u.handle);
  const tokens = [...parseCommands(o.title, handles), ...parseCommands(o.description, handles)];
  const mentioned = [
    ...new Set(
      tokens.flatMap((t) => (t.kind === 'mention' ? ctx.users.filter((u) => u.handle.toLowerCase() === t.handle).map((u) => u.id) : [])),
    ),
  ];
  const event = { ...o, displayTitle: displayTitle(o.title) };
  const occ = o.recurrenceId === '' ? 'single' : o.recurrenceId;
  const key = (kind: string, arg: string): string => `calendar:${o.uid}:${occ}:${kind}:${hash(arg).slice(0, 8)}`;

  const out = new Map<string, Wanted>();
  const add = (d: Derived): void => {
    if (d.kind === 'flag' || out.has(d.sourceKey)) return;
    const content = d.kind === 'event' ? [d.name, d.payload, d.removeWith ?? null] : [d.fireAt, d.userIds, d.action ?? null, event.displayTitle];
    out.set(d.sourceKey, { derived: d, calendarId: o.calendarId, uid: o.uid, occurrence: o.startUtc, title: event.displayTitle, hash: hash(content) });
  };
  for (const token of tokens) {
    for (const plugin of commands) {
      if (plugin.match(token)) for (const d of plugin.derive({ event, token, tokens, users: ctx.users, creatorId: ctx.creatorId, mentioned, key })) add(d);
    }
  }
  const hasRemind = tokens.some((t) => t.kind === 'bang' && t.name === 'remind');
  if (ctx.defaultReminderMin > 0 && !hasRemind && !o.allDay) {
    add({
      sourceKey: key('remind', 'default'),
      kind: 'reminder',
      fireAt: new Date(Date.parse(o.startUtc) - ctx.defaultReminderMin * 60_000).toISOString(),
      userIds: [...new Set([ctx.creatorId, ...mentioned])],
    });
  }
  return [...out.values()];
}

/** Everything that should be derived now: occurrences of local calendars starting in `[now − 1 day, now + horizon]`. */
export function desiredItems(db: ModuleDb, now: Date, ctx: { users: CommandUser[]; horizonDays: number; defaultReminderMin: number }): Wanted[] {
  const from = new Date(now.getTime() - DAY_MS);
  const to = new Date(now.getTime() + ctx.horizonDays * DAY_MS);
  const local = db.all<{ id: string }>("SELECT id FROM m_calendar_calendars WHERE kind = 'local'").map((c) => c.id);
  const rows = rowsInRange(db, local, from, to);
  const creators = new Map(rows.map((r) => [`${r.calendar_id}\u0000${r.uid}`, r.creator_id]));
  const out: Wanted[] = [];
  for (const o of expand(rows, from, to, 5000)) {
    const startMs = Date.parse(o.startUtc);
    if (startMs < from.getTime() || startMs > to.getTime()) continue;
    const creatorId = creators.get(`${o.calendarId}\u0000${o.uid}`);
    if (creatorId === undefined) continue;
    out.push(...deriveOccurrence(o, { users: ctx.users, creatorId, defaultReminderMin: ctx.defaultReminderMin }));
  }
  return out;
}

export interface ReconcileOptions {
  /** Publish the create request of every desired item again, changed or not (receivers are idempotent by sourceKey). */
  replay?: boolean;
}

/**
 * The `derive` job and post-write hook: diffs the desired derived items against `m_calendar_derived` and publishes
 * creates for new or changed items and the stored undo event for vanished ones. Bookkeeping of one event is committed
 * in one transaction **before** its events are published; a crash in between may re-publish later (with `replay`),
 * never duplicate (receivers key on sourceKey). Items of occurrences that simply aged out are dropped silently.
 */
export async function reconcile(host: HostServices, now: Date, opts: ReconcileOptions = {}): Promise<void> {
  const db = host.store.db;
  const config = await host.config<Partial<Config>>();
  const users = (await host.users()).map((u) => ({ id: u.id, handle: u.handle }));
  const wanted = desiredItems(db, now, {
    users,
    horizonDays: config.deriveHorizonDays ?? 14,
    defaultReminderMin: config.defaultReminderMin ?? 0,
  });
  const floor = new Date(now.getTime() - DAY_MS).toISOString();

  const byEvent = new Map<string, { wanted: Wanted[]; existing: DerivedRow[] }>();
  const slot = (calendarId: string, uid: string) => {
    const k = `${calendarId}\u0000${uid}`;
    let s = byEvent.get(k);
    if (!s) byEvent.set(k, (s = { wanted: [], existing: [] }));
    return s;
  };
  for (const w of wanted) slot(w.calendarId, w.uid).wanted.push(w);
  for (const row of db.all<DerivedRow>('SELECT * FROM m_calendar_derived ORDER BY source_key')) slot(row.calendar_id, row.uid).existing.push(row);

  for (const { wanted: want, existing } of byEvent.values()) {
    const have = new Map(existing.map((r) => [r.source_key, r]));
    const wantKeys = new Set(want.map((w) => w.derived.sourceKey));
    const publish: Publish[] = [];

    db.transaction(() => {
      for (const w of want) {
        const d = w.derived;
        const prev = have.get(d.sourceKey);
        const changed = prev?.payload_hash !== w.hash;
        if (!changed && !opts.replay) continue;
        if (changed) {
          db.run(
            `INSERT INTO m_calendar_derived (source_key, calendar_id, uid, occurrence, kind, payload_hash, remove_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (source_key) DO UPDATE SET occurrence = excluded.occurrence, kind = excluded.kind,
               payload_hash = excluded.payload_hash, remove_json = excluded.remove_json`,
            [d.sourceKey, w.calendarId, w.uid, w.occurrence, d.kind, w.hash, d.kind === 'event' && d.removeWith ? JSON.stringify(d.removeWith) : null],
          );
        }
        if (d.kind === 'event') publish.push({ name: d.name, payload: d.payload });
        else if (changed) {
          // A moved reminder fires again at its new time; an unchanged one keeps its fired state.
          db.run(
            `INSERT INTO m_calendar_reminders (source_key, calendar_id, uid, occurrence, fire_at, user_ids, title, action_json, fired)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
             ON CONFLICT (source_key) DO UPDATE SET occurrence = excluded.occurrence, user_ids = excluded.user_ids,
               title = excluded.title, action_json = excluded.action_json,
               fired = CASE WHEN m_calendar_reminders.fire_at = excluded.fire_at THEN m_calendar_reminders.fired ELSE 0 END,
               fire_at = excluded.fire_at`,
            [d.sourceKey, w.calendarId, w.uid, w.occurrence, d.fireAt, JSON.stringify(d.userIds), w.title, d.action ? JSON.stringify(d.action) : null],
          );
        }
      }
      for (const row of existing) {
        if (wantKeys.has(row.source_key)) continue;
        db.run('DELETE FROM m_calendar_derived WHERE source_key = ?', [row.source_key]);
        db.run('DELETE FROM m_calendar_reminders WHERE source_key = ?', [row.source_key]);
        if (row.occurrence < floor) continue; // aged out: the item stays where it is
        if (row.remove_json) publish.push(JSON.parse(row.remove_json) as Publish);
      }
    });

    for (const p of publish) host.bus.publish(p.name as never, p.payload as never);
  }
}
