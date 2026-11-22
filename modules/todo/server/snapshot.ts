import type { EventPayload, ModuleInstance } from '@dash/contract';
import { BUCKETS, settings, type Bucket, type Settings, type Snapshot, type SnapshotItem } from '../manifest.js';
import { BUCKET_RANK, bucketer, localDate } from './buckets.js';
import { isMine, visibleItems, type Item } from './items.js';
import type { ModuleDb } from '@dash/contract';

export const SNAPSHOT_ITEMS = 12;
const SUMMARY_ITEMS = 20;

type User = { id: string; name: string; handle: string };
export type DaySummary = EventPayload<'todo.day.summary'>;

/** overdue → today → week → month → later → none; open before done; then due date, creation time, id. */
export function sortItems(items: Item[], bucketOf: (i: Item) => Bucket): Item[] {
  const rank = new Map(items.map((i) => [i.id, BUCKET_RANK[bucketOf(i)]]));
  return [...items].sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) ||
      (a.due ?? '').localeCompare(b.due ?? '') ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

export type Stamp = () => { epoch: string; rev: number };

/**
 * Built from the instance owner's point of view: the items they can see, filtered by the instance settings.
 * The caller reads the stamp BEFORE its first await and passes it in, then everything here is synchronous, so the
 * content is never older than the rev it carries (writers raise the rev in the step that makes a change visible).
 */
export function buildSnapshot(
  db: ModuleDb,
  instance: ModuleInstance,
  stamp: { epoch: string; rev: number },
  users: User[],
  now: Date,
  timeZone: string,
): Snapshot {
  const parsed = settings.safeParse(instance.settings);
  const s: Settings = parsed.success ? parsed.data : settings.parse({});
  const owner = instance.ownerId;
  const names = new Map(users.map((u) => [u.id, u.name]));
  const bucketOf = bucketer(now, timeZone);
  const items = visibleItems(db, owner).filter((i) => s.lists.includes(i.list) && (s.show === 'all' || isMine(i, owner)));

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const i of items) if (!i.done) counts[bucketOf(i)]++;

  const shown = sortItems(
    items.filter((i) => !(s.hideDone && i.done)),
    bucketOf,
  ).slice(0, SNAPSHOT_ITEMS);
  const rows: SnapshotItem[] = shown.map((i) => ({
    id: i.id,
    title: i.title,
    icon: i.icon,
    list: i.list,
    due: i.due,
    assigneeName: i.assigneeId === null ? null : (names.get(i.assigneeId) ?? null),
    done: i.done,
    version: i.version,
  }));
  return { epoch: stamp.epoch, rev: stamp.rev, timeZone, counts, items: rows, canEdit: true };
}

/** What `todo.day.summary` says about one user: their open overdue items and the ones due today (local day). */
export function buildSummary(db: ModuleDb, userId: string, now: Date, timeZone: string): DaySummary {
  const bucketOf = bucketer(now, timeZone);
  const open = visibleItems(db, userId).filter((i) => !i.done && isMine(i, userId));
  const due = sortItems(open.filter((i) => bucketOf(i) === 'today'), bucketOf).slice(0, SUMMARY_ITEMS);
  return {
    userId,
    date: localDate(now, timeZone),
    overdue: open.filter((i) => bucketOf(i) === 'overdue').length,
    due: due.map((i) => ({ id: i.id, title: i.title, list: i.list })),
  };
}
