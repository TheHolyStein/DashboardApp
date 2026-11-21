import type { HostServices, ModuleInstance, UserId } from '@dash/contract';
import { abortable, type SnapshotPusher } from '@dash/module-kit';
import type { Snapshot } from '../manifest.js';
import { listTimers, toWire } from './timers.js';

export interface NextEvent { title: string; start: string }

export const nextKey = (userId: UserId): string => `next:${userId}`;

/** The boot epoch and an owner's current revision, as one stamp. */
export type Stamp = (owner: UserId) => { epoch: string; rev: number };

/**
 * The stamp is read BEFORE the only await, then the timers (synchronous SQLite) right after it. Writers follow
 * the matching rule (see `server/index.ts`): they bump the rev in the same synchronous step in which their
 * change becomes visible, never before. So whatever this reads, the content is at least as new as the stamp
 * says; it may be newer than its rev (harmless, the next push repeats it), never older.
 */
export async function buildSnapshot(host: HostServices, ownerId: UserId, stamp: Stamp): Promise<Snapshot> {
  const { epoch, rev } = stamp(ownerId);
  const nextEvent = (await host.store.get<NextEvent>(nextKey(ownerId))) ?? null;
  return { epoch, rev, timers: listTimers(host.store.db, ownerId, host.now()).map(toWire), nextEvent };
}

/**
 * Pushes a fresh snapshot to each given instance whose content changed. Snapshots are built first (awaits),
 * then instance membership is re-checked and the pushes happen with no await in between, so an instance
 * removed meanwhile is neither pushed to nor re-added to the pusher's memory.
 */
export async function pushSnapshots(
  host: HostServices,
  pusher: SnapshotPusher,
  instances: ModuleInstance[],
  stamp: Stamp,
  signal?: AbortSignal,
): Promise<void> {
  if (instances.length === 0) return;
  const wait = <T>(p: Promise<T>): Promise<T> => (signal ? abortable(signal, p) : p);
  const built: Array<[ModuleInstance, Snapshot]> = [];
  for (const instance of instances) built.push([instance, await wait(buildSnapshot(host, instance.ownerId, stamp))]);
  const live = new Set((await wait(host.instances())).map((i) => i.id));
  for (const [instance, snapshot] of built) if (live.has(instance.id)) pusher.push(instance.id, snapshot);
}
