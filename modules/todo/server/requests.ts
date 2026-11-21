import type { EventPayload, ModuleDb } from '@dash/contract';
import { createItem, checkIcon, checkTitle, checkUrl, getBySourceKey, impliedDue, MAX_TITLE, normaliseDue, type Item } from './items.js';

/** Items made from a request have no user behind them: the owner is this placeholder unless an assignee is named. */
export const SYSTEM_OWNER = 'system';

export interface Applied {
  item: Item;
  kind: 'created' | 'updated';
}

function quiet<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Upserts by `sourceKey`. An open item gets the request's title, due date and assignee; an item the user completed
 * or deleted is left alone (its row stays as a tombstone), so a request can never bring it back.
 * Returns what changed, or null when nothing did.
 */
export function applyCreateRequest(
  db: ModuleDb,
  req: EventPayload<'todo.create.request'>,
  now: Date,
  timeZone: string,
): Applied | null {
  const title = req.title.trim().slice(0, MAX_TITLE).trim();
  if (title === '' || req.sourceKey === '') return null;
  const existing = getBySourceKey(db, req.sourceKey);
  if (existing) {
    if (existing.done || existing.deleted) return null;
    const due = impliedDue(existing.list, quiet(() => normaliseDue(req.due, timeZone), existing.due), now, timeZone);
    const assigneeId = req.assigneeId;
    if (existing.title === title && existing.due === due && existing.assigneeId === assigneeId) return null;
    const stamp = now.toISOString();
    const changes = db.run(
      `UPDATE m_todo_items SET title = ?, due = ?, assignee_id = ?, version = version + 1, modified_at = ?
       WHERE id = ? AND done = 0 AND deleted = 0`,
      [title, due, assigneeId, stamp, existing.id],
    ).changes;
    if (changes !== 1) return null;
    return { item: { ...existing, title, due, assigneeId, version: existing.version + 1, updatedAt: stamp }, kind: 'updated' };
  }
  const item = createItem(
    db,
    {
      list: req.list,
      title: checkTitle(title),
      ownerId: req.assigneeId ?? SYSTEM_OWNER,
      assigneeId: req.assigneeId,
      due: quiet(() => normaliseDue(req.due, timeZone), null),
      icon: quiet(() => checkIcon(req.icon), null),
      url: quiet(() => checkUrl(req.url), null),
      // Nobody to own it: shared, so that the household sees it.
      ...(req.assigneeId === null ? { visibility: 'shared' as const } : {}),
      sourceKey: req.sourceKey,
    },
    now,
    timeZone,
  );
  return { item, kind: 'created' };
}

/** Deletes the open item with that key. A done or tombstoned one stays (it still blocks a re-creation). */
export function applyRemoveRequest(db: ModuleDb, sourceKey: string): Item | null {
  const existing = getBySourceKey(db, sourceKey);
  if (!existing || existing.done || existing.deleted) return null;
  const changes = db.run('DELETE FROM m_todo_items WHERE id = ? AND done = 0 AND deleted = 0', [existing.id]).changes;
  return changes === 1 ? existing : null;
}

/** "Read later": a deadline item with the link, once per url. */
export function applyReadLater(
  db: ModuleDb,
  req: EventPayload<'item.readLater'>,
  now: Date,
): Applied | null {
  if (quiet(() => checkUrl(req.url), null) === null) return null;
  return applyCreateRequest(
    db,
    { sourceKey: `readLater:${req.url}`, list: 'deadline', title: req.title, due: null, assigneeId: null, icon: null, url: req.url },
    now,
    'UTC',
  );
}
