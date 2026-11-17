import type { HostServices, ModuleInstance, UserId } from '@dash/contract';
import type { Snapshot } from '../manifest.js';
import { listTimers } from './timers.js';

export interface NextEvent { title: string; start: string }

export const nextKey = (userId: UserId): string => `next:${userId}`;

// Last JSON pushed per instance, kept per host so a push only happens when content changed.
// Empty after a restart, so the first tick pushes every instance once.
const lastPushed = new WeakMap<HostServices, Map<string, string>>();
function memo(host: HostServices): Map<string, string> {
  let m = lastPushed.get(host);
  if (!m) {
    m = new Map();
    lastPushed.set(host, m);
  }
  return m;
}

export const hasPushed = (host: HostServices, instanceId: string): boolean => memo(host).has(instanceId);
export const forget = (host: HostServices, instanceId: string): void => {
  memo(host).delete(instanceId);
};

export async function buildSnapshot(host: HostServices, ownerId: UserId): Promise<Snapshot> {
  const timers = listTimers(host.store.db, ownerId, host.now()).map((t) => ({
    id: t.id,
    label: t.label,
    endsAt: t.endsAt,
    durationSec: t.durationSec,
  }));
  const nextEvent = (await host.store.get<NextEvent>(nextKey(ownerId))) ?? null;
  return { timers, nextEvent };
}

/** Pushes a fresh snapshot to each given instance whose content differs from its last push. */
export async function pushSnapshots(host: HostServices, instances: ModuleInstance[]): Promise<void> {
  const last = memo(host);
  for (const instance of instances) {
    const snapshot = await buildSnapshot(host, instance.ownerId);
    const json = JSON.stringify(snapshot);
    if (last.get(instance.id) === json) continue;
    last.set(instance.id, json);
    host.push(instance.id, snapshot);
  }
}
