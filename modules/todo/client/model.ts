import { DashError } from '@dash/contract';
import type { Bucket, ItemList, RepeatUnit, TodoListId, WireItem } from '../manifest.js';

/** The part of an item a row shows. Built from the API's items (detail) or the snapshot's (tile, shared pages). */
export interface Row {
  id: string;
  title: string;
  icon: string | null;
  qty: string | null;
  note: string | null;
  due: string | null;
  done: boolean;
  version: number;
  assigneeName: string | null;
  fromCalendar: boolean;
  overdue: boolean;
}

export const LIST_ORDER: readonly TodoListId[] = ['week', 'month', 'deadline', 'shopping', 'chores'];

/** The headers of the tile, in display order. `done` collects finished items when the tile shows them. */
export type Group = Bucket | 'done';
export const GROUPS: readonly Group[] = ['overdue', 'today', 'week', 'month', 'later', 'none', 'done'];

/** A new server epoch (a restart) always wins, even with a lower rev; within one epoch only `rev >=` is applied. */
export function newer<T extends { epoch: string; rev: number }>(held: T | null, incoming: T): T {
  if (!held || incoming.epoch !== held.epoch || incoming.rev >= held.rev) return incoming;
  return held;
}

/** The item the server sent along with a 409, or null for any other error. */
export function conflictItem(err: unknown): WireItem | null {
  if (!(err instanceof DashError) || err.code !== 'conflict') return null;
  const item = (err.details as { item?: WireItem } | undefined)?.item;
  return item ?? null;
}

/** Replaces one item inside a held list (the stamp stays: the item is newer, the list as a whole is not). */
export function withItem(list: ItemList, item: WireItem): ItemList {
  return { ...list, items: list.items.map((i) => (i.id === item.id ? item : i)) };
}

/** Items in the caller's own order first (as far as they are known), the rest after them in server order. */
export function inOrder<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order || order.length === 0) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = items.filter((i) => rank.has(i.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...known, ...items.filter((i) => !rank.has(i.id))];
}

export function rowOf(item: WireItem, names: Map<string, string>): Row {
  return {
    id: item.id,
    title: item.title,
    icon: item.icon,
    qty: item.qty,
    note: item.note,
    due: item.due,
    done: item.done,
    version: item.version,
    assigneeName: item.assigneeId === null ? null : (names.get(item.assigneeId) ?? null),
    fromCalendar: item.sourceKey?.startsWith('calendar:') ?? false,
    overdue: item.bucket === 'overdue' && !item.done,
  };
}

/** `title @handle`: only `@handle` (assign) is understood. The handle is the first one found. */
export function parseQuickAdd(text: string): { title: string; handle: string | null } {
  const m = /(?:^|\s)@([\p{L}\p{N}_.-]+)/u.exec(text);
  if (!m) return { title: text.replace(/\s+/g, ' ').trim(), handle: null };
  const rest = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  return { title: rest.replace(/\s+/g, ' ').trim(), handle: (m[1] ?? '').toLowerCase() };
}

/** An icon key (`todo`) as opposed to an emoji. */
export const isIconKey = (icon: string): boolean => /^[a-z][a-z0-9-]*$/.test(icon);

export type EditorValues = {
  title: string;
  icon: string | null;
  note: string | null;
  qty: string | null;
  /** Only present when the user changed it: an unchanged due date keeps its time of day. */
  due?: string | null;
  assigneeId: string | null;
  visibility: 'private' | 'shared';
  repeatEvery: number | null;
  repeatUnit: RepeatUnit | null;
  rotation: string[];
};
