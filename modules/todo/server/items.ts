import { DashError, type ModuleDb } from '@dash/contract';
import { newId } from '@dash/module-kit';
import { LISTS, type RepeatUnit, type TodoListId, type WireItem } from '../manifest.js';
import { addInterval, bucketer, endOfIsoWeek, endOfLocalDay, endOfMonth, makeZone } from './buckets.js';

export interface Item {
  id: string;
  list: TodoListId;
  title: string;
  icon: string | null;
  note: string | null;
  qty: string | null;
  due: string | null;
  ownerId: string;
  assigneeId: string | null;
  visibility: 'private' | 'shared';
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
  version: number;
  sourceKey: string | null;
  url: string | null;
  repeatEvery: number | null;
  repeatUnit: RepeatUnit | null;
  rotation: string[];
  rotationIdx: number;
  deleted: boolean;
  /** The next occurrence this (done) chore created, if any. */
  spawnedId: string | null;
  /** Day of month a monthly chore keeps (31 Jan -> 28 Feb -> 31 Mar). */
  anchorDay: number | null;
  /** The last request payload that touched this item (JSON), for items made by a request. */
  requestJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewItem {
  list: TodoListId;
  title: string;
  ownerId: string;
  icon?: string | null | undefined;
  note?: string | null | undefined;
  qty?: string | null | undefined;
  /** An ISO instant, or a `YYYY-MM-DD` day (meaning 23:59 local that day). */
  due?: string | null | undefined;
  assigneeId?: string | null | undefined;
  visibility?: 'private' | 'shared' | undefined;
  url?: string | null | undefined;
  repeatEvery?: number | null | undefined;
  repeatUnit?: RepeatUnit | null | undefined;
  rotation?: string[] | undefined;
  sourceKey?: string | null | undefined;
  requestJson?: string | null | undefined;
}

export type Patch = Partial<Omit<NewItem, 'ownerId' | 'sourceKey'>>;

interface Row {
  id: string;
  list: string;
  title: string;
  icon: string | null;
  note: string | null;
  qty: string | null;
  due: string | null;
  owner_id: string;
  assignee_id: string | null;
  visibility: string;
  done: number;
  done_at: string | null;
  done_by: string | null;
  version: number;
  source_key: string | null;
  url: string | null;
  repeat_every: number | null;
  repeat_unit: string | null;
  rotation: string;
  rotation_idx: number;
  deleted: number;
  spawned_id: string | null;
  anchor_day: number | null;
  request_json: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, list, title, icon, note, qty, due, owner_id, assignee_id, visibility, done, done_at, done_by, version,
  source_key, url, repeat_every, repeat_unit, rotation, rotation_idx, deleted, spawned_id, anchor_day, request_json, created_at, updated_at`;

export const MAX_TITLE = 200;
const MAX_NOTE = 2000;
const MAX_QTY = 40;
const MAX_URL = 2000;
const MAX_ROTATION = 12;
const MAX_EVERY = 365;
const ICON_KEY = /^[a-z][a-z0-9-]{0,31}$/;

function parseRotation(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToItem(r: Row): Item {
  return {
    id: r.id,
    list: r.list as TodoListId,
    title: r.title,
    icon: r.icon,
    note: r.note,
    qty: r.qty,
    due: r.due,
    ownerId: r.owner_id,
    assigneeId: r.assignee_id,
    visibility: r.visibility === 'shared' ? 'shared' : 'private',
    done: r.done === 1,
    doneAt: r.done_at,
    doneBy: r.done_by,
    version: r.version,
    sourceKey: r.source_key,
    url: r.url,
    repeatEvery: r.repeat_every,
    repeatUnit: r.repeat_unit as RepeatUnit | null,
    rotation: parseRotation(r.rotation),
    rotationIdx: r.rotation_idx,
    deleted: r.deleted === 1,
    spawnedId: r.spawned_id,
    anchorDay: r.anchor_day,
    requestJson: r.request_json,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const invalid = (msg: string): DashError => new DashError('invalid', msg);

/** Shared items are visible to everyone; a private item to its owner and its assignee. */
export function visibleTo(item: Pick<Item, 'visibility' | 'ownerId' | 'assigneeId'>, userId: string): boolean {
  return item.visibility === 'shared' || item.ownerId === userId || item.assigneeId === userId;
}

/** "Mine" = not assigned to somebody else. */
export function isMine(item: Pick<Item, 'assigneeId'>, userId: string): boolean {
  return item.assigneeId === null || item.assigneeId === userId;
}

export const defaultVisibility = (list: TodoListId): 'private' | 'shared' =>
  list === 'shopping' || list === 'chores' ? 'shared' : 'private';

export function toWire(item: Item, bucket: WireItem['bucket']): WireItem {
  return {
    id: item.id,
    list: item.list,
    title: item.title,
    icon: item.icon,
    note: item.note,
    qty: item.qty,
    due: item.due,
    ownerId: item.ownerId,
    assigneeId: item.assigneeId,
    visibility: item.visibility,
    done: item.done,
    doneAt: item.doneAt,
    doneBy: item.doneBy,
    version: item.version,
    url: item.url,
    fromCalendar: item.sourceKey?.startsWith('calendar:') ?? false,
    repeatEvery: item.repeatEvery,
    repeatUnit: item.repeatUnit,
    rotation: item.rotation,
    rotationIdx: item.rotationIdx,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    bucket,
  };
}

export function wireOf(item: Item, now: Date, timeZone: string): WireItem {
  return toWire(item, bucketer(now, timeZone)(item));
}

export function checkTitle(title: string): string {
  const t = title.trim();
  if (t === '') throw invalid('title is required');
  if (t.length > MAX_TITLE) throw invalid(`title is longer than ${MAX_TITLE} characters`);
  return t;
}

/** An icon key (`todo`, `shopping-cart`) or a single emoji. */
export function checkIcon(icon: string | null | undefined): string | null {
  if (icon === null || icon === undefined || icon === '') return null;
  if (ICON_KEY.test(icon)) return icon;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(icon)];
  if (graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(icon)) return icon;
  throw invalid('icon must be an icon key or a single emoji');
}

function checkText(v: string | null | undefined, max: number, what: string): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t === '') return null;
  if (t.length > max) throw invalid(`${what} is longer than ${max} characters`);
  return t;
}

export function checkUrl(v: string | null | undefined): string | null {
  const t = checkText(v, MAX_URL, 'url');
  if (t === null) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw invalid('url must be an http(s) address');
  }
  return t;
}

/** A due date as an ISO instant. A bare `YYYY-MM-DD` means 23:59 local that day. */
export function normaliseDue(input: string | null | undefined, timeZone: string): string | null {
  if (input === null || input === undefined || input === '') return null;
  const day = endOfLocalDay(input, timeZone);
  if (day) return day.toISOString();
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw invalid('due is not a valid date');
  return new Date(ms).toISOString();
}

/** Week and month items without an explicit due date are due at the end of the current week or month. */
export function impliedDue(list: TodoListId, due: string | null, now: Date, timeZone: string): string | null {
  if (due !== null) return due;
  if (list === 'week') return endOfIsoWeek(now, timeZone).toISOString();
  if (list === 'month') return endOfMonth(now, timeZone).toISOString();
  return null;
}

interface Repeat {
  every: number | null;
  unit: RepeatUnit | null;
  rotation: string[];
}

function checkRepeat(list: TodoListId, r: Repeat): Repeat {
  const rotation = [...new Set(r.rotation.filter((x) => x !== ''))];
  if (rotation.length > MAX_ROTATION) throw invalid(`rotation has more than ${MAX_ROTATION} people`);
  if ((r.every === null) !== (r.unit === null)) throw invalid('repeat needs both an interval and a unit');
  if (r.every !== null) {
    if (!Number.isInteger(r.every) || r.every < 1 || r.every > MAX_EVERY) throw invalid('repeat interval must be 1 to 365');
    if (r.unit !== 'day' && r.unit !== 'week' && r.unit !== 'month') throw invalid('repeat unit must be day, week or month');
  }
  if (list !== 'chores' && (r.every !== null || rotation.length > 0)) throw invalid('only chores repeat or rotate');
  return { every: r.every, unit: r.unit, rotation };
}

function insert(db: ModuleDb, item: Item): void {
  db.run(
    `INSERT INTO m_todo_items (${COLUMNS}) VALUES (${COLUMNS.split(',').map(() => '?').join(', ')})`,
    [
      item.id, item.list, item.title, item.icon, item.note, item.qty, item.due, item.ownerId, item.assigneeId, item.visibility,
      item.done ? 1 : 0, item.doneAt, item.doneBy, item.version, item.sourceKey, item.url, item.repeatEvery, item.repeatUnit,
      JSON.stringify(item.rotation), item.rotationIdx, item.deleted ? 1 : 0, item.spawnedId, item.anchorDay, item.requestJson,
      item.createdAt, item.updatedAt,
    ],
  );
}

export function getItem(db: ModuleDb, id: string): Item | undefined {
  const row = db.get<Row>(`SELECT ${COLUMNS} FROM m_todo_items WHERE id = ?`, [id]);
  return row ? rowToItem(row) : undefined;
}

export function getBySourceKey(db: ModuleDb, ownerId: string, sourceKey: string): Item | undefined {
  const row = db.get<Row>(`SELECT ${COLUMNS} FROM m_todo_items WHERE owner_id = ? AND source_key = ?`, [ownerId, sourceKey]);
  return row ? rowToItem(row) : undefined;
}

/** Every item with that key, whoever owns it. */
export function allBySourceKey(db: ModuleDb, sourceKey: string): Item[] {
  return db.all<Row>(`SELECT ${COLUMNS} FROM m_todo_items WHERE source_key = ?`, [sourceKey]).map(rowToItem);
}

/** The day of month a monthly chore with this due date repeats on; null for any other repeat. */
export function anchorOf(due: string | null, unit: RepeatUnit | null, timeZone: string): number | null {
  if (unit !== 'month' || due === null) return null;
  const ms = Date.parse(due);
  return Number.isNaN(ms) ? null : makeZone(timeZone).parts(ms).d;
}

/** Items the user may see (not deleted), unordered. */
export function visibleItems(db: ModuleDb, userId: string): Item[] {
  return db
    .all<Row>(`SELECT ${COLUMNS} FROM m_todo_items WHERE deleted = 0`)
    .map(rowToItem)
    .filter((i) => visibleTo(i, userId));
}

export function createItem(db: ModuleDb, input: NewItem, now: Date, timeZone: string): Item {
  const list = input.list;
  if (!LISTS.includes(list)) throw invalid('unknown list');
  const rotation = input.rotation ?? [];
  const repeat = checkRepeat(list, { every: input.repeatEvery ?? null, unit: input.repeatUnit ?? null, rotation });
  const assigneeId = input.assigneeId ?? repeat.rotation[0] ?? null;
  const idx = assigneeId === null ? 0 : Math.max(0, repeat.rotation.indexOf(assigneeId));
  const stamp = now.toISOString();
  const due = impliedDue(list, normaliseDue(input.due, timeZone), now, timeZone);
  const item: Item = {
    id: newId(now),
    list,
    title: checkTitle(input.title),
    icon: checkIcon(input.icon),
    note: checkText(input.note, MAX_NOTE, 'note'),
    qty: checkText(input.qty, MAX_QTY, 'quantity'),
    due,
    ownerId: input.ownerId,
    assigneeId,
    visibility: input.visibility ?? defaultVisibility(list),
    done: false,
    doneAt: null,
    doneBy: null,
    version: 1,
    sourceKey: input.sourceKey ?? null,
    url: checkUrl(input.url),
    repeatEvery: repeat.every,
    repeatUnit: repeat.unit,
    rotation: repeat.rotation,
    rotationIdx: idx,
    deleted: false,
    spawnedId: null,
    anchorDay: anchorOf(due, repeat.unit, timeZone),
    requestJson: input.requestJson ?? null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  insert(db, item);
  return item;
}

/** The item for a caller who may touch it. A stranger gets the same not_found as for a missing id, so existence does not leak. */
export function accessible(db: ModuleDb, id: string, userId: string): Item {
  const item = getItem(db, id);
  if (!item || item.deleted || !visibleTo(item, userId)) throw new DashError('not_found', 'item not found');
  return item;
}

function conflict(item: Item, now: Date, timeZone: string): DashError {
  return new DashError('conflict', 'the item was changed by someone else', { item: wireOf(item, now, timeZone) });
}

/** Version check and bump in one statement: of two writers holding the same version, exactly one gets `changes = 1`. */
function bumped(db: ModuleDb, sql: string, params: unknown[], id: string, version: number): boolean {
  return db.run(`${sql} WHERE id = ? AND version = ? AND deleted = 0`, [...params, id, version]).changes === 1;
}

export function updateItem(
  db: ModuleDb,
  id: string,
  userId: string,
  version: number,
  patch: Patch,
  now: Date,
  timeZone: string,
): Item {
  const cur = accessible(db, id, userId);
  if (cur.version !== version) throw conflict(cur, now, timeZone);
  const list = patch.list ?? cur.list;
  const repeat = checkRepeat(list, {
    every: patch.repeatEvery === undefined ? cur.repeatEvery : patch.repeatEvery,
    unit: patch.repeatUnit === undefined ? cur.repeatUnit : patch.repeatUnit,
    rotation: patch.rotation ?? cur.rotation,
  });
  const assigneeId = patch.assigneeId === undefined ? cur.assigneeId : patch.assigneeId;
  const due =
    patch.due !== undefined || patch.list !== undefined
      ? impliedDue(list, patch.due === undefined ? cur.due : normaliseDue(patch.due, timeZone), now, timeZone)
      : cur.due;
  const idx = assigneeId !== null && repeat.rotation.includes(assigneeId) ? repeat.rotation.indexOf(assigneeId) : cur.rotationIdx;
  const reanchor = patch.due !== undefined || patch.list !== undefined || repeat.unit !== cur.repeatUnit;
  const next: Item = {
    ...cur,
    list,
    title: patch.title === undefined ? cur.title : checkTitle(patch.title),
    icon: patch.icon === undefined ? cur.icon : checkIcon(patch.icon),
    note: patch.note === undefined ? cur.note : checkText(patch.note, MAX_NOTE, 'note'),
    qty: patch.qty === undefined ? cur.qty : checkText(patch.qty, MAX_QTY, 'quantity'),
    due,
    assigneeId,
    visibility: patch.visibility ?? cur.visibility,
    url: patch.url === undefined ? cur.url : checkUrl(patch.url),
    repeatEvery: repeat.every,
    repeatUnit: repeat.unit,
    rotation: repeat.rotation,
    rotationIdx: idx,
    anchorDay: reanchor ? anchorOf(due, repeat.unit, timeZone) : cur.anchorDay,
    version: cur.version + 1,
    updatedAt: now.toISOString(),
  };
  const ok = bumped(
    db,
    `UPDATE m_todo_items SET list = ?, title = ?, icon = ?, note = ?, qty = ?, due = ?, assignee_id = ?, visibility = ?, url = ?,
      repeat_every = ?, repeat_unit = ?, rotation = ?, rotation_idx = ?, anchor_day = ?, version = version + 1, updated_at = ?`,
    [
      next.list, next.title, next.icon, next.note, next.qty, next.due, next.assigneeId, next.visibility, next.url,
      next.repeatEvery, next.repeatUnit, JSON.stringify(next.rotation), next.rotationIdx, next.anchorDay, next.updatedAt,
    ],
    id,
    version,
  );
  if (!ok) throw conflict(accessible(db, id, userId), now, timeZone);
  return next;
}

/**
 * Marks an item done. A repeating chore also gets its next occurrence (`due + every x unit`, assigned to the next
 * person in the rotation); the pair is written in one transaction and the done row remembers the spawned id. When it
 * already points to a live open occurrence (the user undid the chore and the occurrence had been touched), nothing is
 * spawned again. Done on an item that is already done changes nothing.
 */
export function completeItem(
  db: ModuleDb,
  id: string,
  userId: string,
  version: number,
  now: Date,
  timeZone = 'UTC',
): { item: Item; next: Item | null } {
  const cur = accessible(db, id, userId);
  if (cur.version !== version) throw conflict(cur, now, timeZone);
  if (cur.done) return { item: cur, next: null };
  return db.transaction(() => {
    const stamp = now.toISOString();
    const ok = bumped(
      db,
      'UPDATE m_todo_items SET done = 1, done_at = ?, done_by = ?, version = version + 1, updated_at = ?',
      [stamp, userId, stamp],
      id,
      version,
    );
    if (!ok) throw conflict(accessible(db, id, userId), now, timeZone);
    let next: Item | null = null;
    const held = cur.spawnedId === null ? undefined : getItem(db, cur.spawnedId);
    const alive = held !== undefined && !held.deleted && !held.done;
    if (cur.repeatEvery !== null && cur.repeatUnit !== null && !alive) {
      const base = cur.due === null ? now : new Date(cur.due);
      const idx = cur.rotation.length > 0 ? (cur.rotationIdx + 1) % cur.rotation.length : 0;
      const anchor = cur.anchorDay ?? anchorOf(base.toISOString(), cur.repeatUnit, timeZone);
      next = {
        ...cur,
        id: newId(now),
        due: addInterval(base, cur.repeatEvery, cur.repeatUnit, timeZone, anchor ?? undefined).toISOString(),
        assigneeId: cur.rotation[idx] ?? cur.assigneeId,
        rotationIdx: idx,
        done: false,
        doneAt: null,
        doneBy: null,
        version: 1,
        sourceKey: null,
        requestJson: null,
        spawnedId: null,
        anchorDay: anchor,
        createdAt: stamp,
        updatedAt: stamp,
      };
      insert(db, next);
      db.run('UPDATE m_todo_items SET spawned_id = ? WHERE id = ?', [next.id, id]);
    }
    return { item: accessible(db, id, userId), next };
  });
}

/**
 * Done -> open again. The next occurrence the completion created is removed with it, in the same transaction, when it
 * is still open and untouched (version 1); one somebody edited stays, and completing again will not spawn another.
 * The done row's own `rotation_idx` was never changed, so the rotation is where it was before the completion.
 */
export function reopenItem(
  db: ModuleDb,
  id: string,
  userId: string,
  version: number,
  now: Date,
  timeZone = 'UTC',
): { item: Item; removedId: string | null } {
  const cur = accessible(db, id, userId);
  if (cur.version !== version) throw conflict(cur, now, timeZone);
  if (!cur.done) return { item: cur, removedId: null };
  return db.transaction(() => {
    const ok = bumped(
      db,
      'UPDATE m_todo_items SET done = 0, done_at = NULL, done_by = NULL, version = version + 1, updated_at = ?',
      [now.toISOString()],
      id,
      version,
    );
    if (!ok) throw conflict(accessible(db, id, userId), now, timeZone);
    let removedId: string | null = null;
    if (cur.spawnedId !== null) {
      const gone = db.run('DELETE FROM m_todo_items WHERE id = ? AND done = 0 AND deleted = 0 AND version = 1', [cur.spawnedId]).changes === 1;
      if (gone) {
        removedId = cur.spawnedId;
        db.run('UPDATE m_todo_items SET spawned_id = NULL WHERE id = ?', [id]);
      }
    }
    return { item: accessible(db, id, userId), removedId };
  });
}

/** An item that came from a request keeps a tombstone so the request cannot bring it back; any other is removed. */
export function deleteItem(db: ModuleDb, id: string, userId: string, version: number, now: Date, timeZone = 'UTC'): Item {
  const cur = accessible(db, id, userId);
  if (cur.version !== version) throw conflict(cur, now, timeZone);
  const ok =
    cur.sourceKey === null
      ? db.run('DELETE FROM m_todo_items WHERE id = ? AND version = ?', [id, version]).changes === 1
      : bumped(db, 'UPDATE m_todo_items SET deleted = 1, version = version + 1, updated_at = ?', [now.toISOString()], id, version);
  if (!ok) throw conflict(accessible(db, id, userId), now, timeZone);
  return cur;
}

/** Removes the done items of one list that the user can see. Returns their ids. */
export function clearDone(db: ModuleDb, userId: string, list: TodoListId, now: Date): string[] {
  return db.transaction(() => {
    const gone = visibleItems(db, userId).filter((i) => i.list === list && i.done);
    for (const i of gone) {
      if (i.sourceKey === null) db.run('DELETE FROM m_todo_items WHERE id = ?', [i.id]);
      else db.run('UPDATE m_todo_items SET deleted = 1, version = version + 1, updated_at = ? WHERE id = ?', [now.toISOString(), i.id]);
    }
    return gone.map((i) => i.id);
  });
}

/** Done items older than `days` go away; request tombstones stay. */
export function purgeDone(db: ModuleDb, now: Date, days: number): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return db.run('DELETE FROM m_todo_items WHERE done = 1 AND done_at < ? AND source_key IS NULL', [cutoff]).changes;
}
