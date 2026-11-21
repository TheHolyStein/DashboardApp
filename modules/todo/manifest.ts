import { z } from 'zod';
import { TodoList } from '@dash/contract';
import { defineManifest } from '@dash/module-kit';

export const LISTS = TodoList.options;
export type TodoListId = z.infer<typeof TodoList>;
export type Bucket = 'overdue' | 'today' | 'week' | 'month' | 'later' | 'none';
export const BUCKETS: readonly Bucket[] = ['overdue', 'today', 'week', 'month', 'later', 'none'];
export type RepeatUnit = 'day' | 'week' | 'month';

/** Per-instance settings. The `.meta()` blocks drive the generated settings form. */
export const settings = z.object({
  lists: z.array(TodoList).default([...LISTS]).meta({ label: 'Lists', help: 'Which lists this tile shows' }),
  show: z.enum(['mine', 'all']).default('mine').meta({ label: 'Show', help: 'Mine = not assigned to someone else' }),
  hideDone: z.boolean().default(true).meta({ label: 'Hide done items' }),
});
export type Settings = z.infer<typeof settings>;

/** An item as the API sends it (no source key, no tombstone marker). `bucket` is computed in the caller's time zone. */
export interface WireItem {
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
  url: string | null;
  /** Who made it, for items created by a request (for example `calendar:<uid>`); null for items made by hand. */
  sourceKey: string | null;
  repeatEvery: number | null;
  repeatUnit: RepeatUnit | null;
  rotation: string[];
  rotationIdx: number;
  createdAt: string;
  updatedAt: string;
  bucket: Bucket;
}

/**
 * The body of every items response: the caller's visible items at `{ epoch, rev }`. `rev` is one counter for the
 * whole module (the data is shared between users), raised in the same synchronous step in which a change becomes
 * visible. `order` is the caller's own per-list order (ids), `userId` the caller.
 */
export type ItemList = {
  epoch: string;
  rev: number;
  userId: string;
  items: WireItem[];
  order: Partial<Record<TodoListId, string[]>>;
};

export type SnapshotItem = {
  id: string;
  title: string;
  icon: string | null;
  list: TodoListId;
  due: string | null;
  assigneeName: string | null;
  done: boolean;
  version: number;
};

/** What the server pushes to each placed instance, built from the instance owner's point of view. */
export type Snapshot = {
  epoch: string;
  rev: number;
  counts: Record<Bucket, number>;
  items: SnapshotItem[];
  canEdit: boolean;
};

export default defineManifest({
  id: 'todo',
  name: 'Todo',
  description: 'Week, month and deadline tasks, shopping list and repeating chores shared by the household.',
  version: '0.1.0',
  icon: 'todo',
  scope: 'shared',
  multiInstance: true,
  tile: { default: { w: 3, h: 4 }, min: { w: 2, h: 2 }, max: { w: 6, h: 8 } },
  settings,
  config: z.object({}),
  levels: ['view', 'edit'],
  jobs: [{ name: 'rollover', intervalSec: 900, mode: 'always', per: 'module' }],
  publishes: ['todo.changed', 'todo.day.summary'],
  subscribes: ['todo.create.request', 'todo.remove.request', 'item.readLater'],
  outbound: [],
});
