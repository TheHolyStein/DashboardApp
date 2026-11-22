import type { EventPayload, ModuleDb } from '@dash/contract';
import {
  allBySourceKey,
  checkIcon,
  checkTitle,
  checkUrl,
  createItem,
  defaultVisibility,
  getBySourceKey,
  MAX_TITLE,
  normaliseDue,
  type Item,
} from './items.js';

/** Items made from a household request (no owner) belong to this placeholder and are shared. */
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

/** The request fields an item follows. Stored with the item so a re-emitted request only applies what it changed. */
interface Last {
  title: string;
  due: string | null;
  assigneeId: string | null;
}

function parseLast(json: string | null): Last | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as Partial<Last>;
    if (typeof v.title !== 'string') return null;
    return { title: v.title, due: v.due ?? null, assigneeId: v.assigneeId ?? null };
  } catch {
    return null;
  }
}

/**
 * Upserts by `(owner, sourceKey)`; the owner is `ownerId`, or the household placeholder (shared) when null/absent.
 * An open item follows the request field by field: only fields whose request value changed since the last request are
 * written, so a manual edit of the title or assignee survives a re-emitted request. A request without a due date never
 * clears or recomputes the item's due. An item the user completed or deleted is left alone (its row stays as a
 * tombstone), so a request can never bring it back. Returns what changed, or null when nothing did.
 */
export function applyCreateRequest(
  db: ModuleDb,
  req: EventPayload<'todo.create.request'>,
  now: Date,
  timeZone: string,
): Applied | null {
  const title = req.title.trim().slice(0, MAX_TITLE).trim();
  if (title === '' || req.sourceKey === '') return null;
  const ownerId = req.ownerId ?? SYSTEM_OWNER;
  const reqDue = quiet(() => normaliseDue(req.due, timeZone), null);
  const lastJson = JSON.stringify({ title, due: reqDue, assigneeId: req.assigneeId } satisfies Last);
  const existing = getBySourceKey(db, ownerId, req.sourceKey);
  if (existing) {
    if (existing.done || existing.deleted) return null;
    const before = parseLast(existing.requestJson);
    const newTitle = before === null || before.title !== title ? title : existing.title;
    const newDue = reqDue !== null && (before === null || before.due !== reqDue) ? reqDue : existing.due;
    const newAssignee = before === null || before.assigneeId !== req.assigneeId ? req.assigneeId : existing.assigneeId;
    if (existing.title === newTitle && existing.due === newDue && existing.assigneeId === newAssignee) {
      if (existing.requestJson !== lastJson) db.run('UPDATE m_todo_items SET request_json = ? WHERE id = ?', [lastJson, existing.id]);
      return null;
    }
    const stamp = now.toISOString();
    const changes = db.run(
      `UPDATE m_todo_items SET title = ?, due = ?, assignee_id = ?, request_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND done = 0 AND deleted = 0`,
      [newTitle, newDue, newAssignee, lastJson, stamp, existing.id],
    ).changes;
    if (changes !== 1) return null;
    return {
      item: { ...existing, title: newTitle, due: newDue, assigneeId: newAssignee, requestJson: lastJson, version: existing.version + 1, updatedAt: stamp },
      kind: 'updated',
    };
  }
  const visibility = req.visibility ?? (req.ownerId ? defaultVisibility(req.list) : 'shared');
  const item = createItem(
    db,
    {
      list: req.list,
      title: checkTitle(title),
      ownerId,
      assigneeId: req.assigneeId,
      due: reqDue,
      icon: quiet(() => checkIcon(req.icon), null),
      url: quiet(() => checkUrl(req.url), null),
      visibility,
      sourceKey: req.sourceKey,
      requestJson: lastJson,
    },
    now,
    timeZone,
  );
  return { item, kind: 'created' };
}

/** Deletes the open items with that key, whoever owns them. A done or tombstoned one stays (it still blocks a re-creation). */
export function applyRemoveRequest(db: ModuleDb, sourceKey: string): Item[] {
  const gone: Item[] = [];
  for (const existing of allBySourceKey(db, sourceKey)) {
    if (existing.done || existing.deleted) continue;
    if (db.run('DELETE FROM m_todo_items WHERE id = ? AND done = 0 AND deleted = 0', [existing.id]).changes === 1) gone.push(existing);
  }
  return gone;
}

/** "Read later": a private deadline item with the link, once per url and owner. */
export function applyReadLater(
  db: ModuleDb,
  req: EventPayload<'item.readLater'>,
  now: Date,
  owners: Array<{ id: string; timeZone: string }>,
): Applied[] {
  if (quiet(() => checkUrl(req.url), null) === null) return [];
  const out: Applied[] = [];
  for (const owner of owners) {
    const res = applyCreateRequest(
      db,
      {
        sourceKey: `readLater:${req.url}`,
        list: 'deadline',
        title: req.title,
        due: null,
        assigneeId: null,
        icon: null,
        url: req.url,
        ownerId: owner.id,
        visibility: 'private',
      },
      now,
      owner.timeZone,
    );
    if (res) out.push(res);
  }
  return out;
}
