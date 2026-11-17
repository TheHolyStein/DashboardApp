import type { HostServices, InstanceId } from '@dash/contract';

export interface SnapshotPusher {
  /** Pushes `data` unless it is identical (JSON) to the last push for this instance. Returns false when nothing was sent. */
  push(instanceId: InstanceId | null, data: unknown): boolean;
  /** The next push for this instance goes out even if unchanged (call when an instance is removed). */
  forget(instanceId: InstanceId | null): void;
  forgetAll(): void;
}

const MODULE_WIDE = '\u0000module';

/**
 * Dedupes `host.push`. State lives in the returned object, owned by the caller (create one per host, for
 * example inside `routes`/`jobs` setup or lazily per host); there is no module-level state.
 * Comparison is by JSON text: build snapshots deterministically (stable key order); call `forget(instanceId)` when an
 * instance is removed.
 */
export function createSnapshotPusher(host: Pick<HostServices, 'push'>): SnapshotPusher {
  const last = new Map<string, string>();
  const keyOf = (id: InstanceId | null): string => id ?? MODULE_WIDE;
  return {
    push(instanceId, data) {
      const json = JSON.stringify(data) ?? 'undefined';
      const key = keyOf(instanceId);
      if (last.get(key) === json) return false;
      // Recorded only after a successful push: a throwing push is not remembered, so the next identical one goes out.
      host.push(instanceId, data);
      last.set(key, json);
      return true;
    },
    forget: (instanceId) => void last.delete(keyOf(instanceId)),
    forgetAll: () => last.clear(),
  };
}
