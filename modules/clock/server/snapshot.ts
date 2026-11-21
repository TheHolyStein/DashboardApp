import type { HostServices, ModuleInstance, UserId } from '@dash/contract';
import { abortable, type SnapshotPusher } from '@dash/module-kit';
import type { Snapshot } from '../manifest.js';
import { listTimers, toWire } from './timers.js';

export interface NextEvent { title: string; start: string }

export const nextKey = (userId: UserId): string => `next:${userId}`;

/** `rev` and the timer list are read together after the last await, so they always describe the same moment. */
export async function buildSnapshot(host: HostServices, ownerId: UserId, revOf: (owner: UserId) => number): Promise<Snapshot> {
  const nextEvent = (await host.store.get<NextEvent>(nextKey(ownerId))) ?? null;
  return { rev: revOf(ownerId), timers: listTimers(host.store.db, ownerId, host.now()).map(toWire), nextEvent };
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
  revOf: (owner: UserId) => number,
  signal?: AbortSignal,
): Promise<void> {
  if (instances.length === 0) return;
  const wait = <T>(p: Promise<T>): Promise<T> => (signal ? abortable(signal, p) : p);
  const built: Array<[ModuleInstance, Snapshot]> = [];
  for (const instance of instances) built.push([instance, await wait(buildSnapshot(host, instance.ownerId, revOf))]);
  const live = new Set((await wait(host.instances())).map((i) => i.id));
  for (const [instance, snapshot] of built) if (live.has(instance.id)) pusher.push(instance.id, snapshot);
}
