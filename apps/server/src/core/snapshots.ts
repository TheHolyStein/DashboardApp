import type BetterSqlite3 from 'better-sqlite3';
import {
  DashError,
  type InstanceId,
  type ModuleId,
  type ModuleManifest,
  type SnapshotDto as SnapshotDtoSchema,
} from '@dash/contract';
import type { z } from 'zod';
import type { LoggerLike, SnapshotsDep } from './modules/deps.js';

export type SnapshotDto = z.infer<typeof SnapshotDtoSchema>;

export const MAX_SNAPSHOT_BYTES = 256 * 1024;

export interface StoredSnapshot {
  moduleId: ModuleId;
  /** null for a module-wide snapshot. */
  instanceId: InstanceId | null;
  /** Parsed JSON as stored. */
  data: unknown;
  updatedAt: string;
  jobOk: boolean;
}

export interface SnapshotsDeps {
  db: BetterSqlite3.Database;
  now: () => Date;
  manifests: (moduleId: ModuleId) => ModuleManifest | undefined;
  logger: LoggerLike;
  /** Called after a snapshot was stored (main.ts wires it to `stream.sendSnapshot`). */
  onStored: (moduleId: ModuleId, instanceId: InstanceId | null, snap: StoredSnapshot) => void;
}

export interface Snapshots extends SnapshotsDep {
  /** Exact row for (module, instance|null). */
  get(moduleId: ModuleId, instanceId: InstanceId | null): StoredSnapshot | undefined;
  /** What an instance shows: its own snapshot, else the module-wide one. */
  forInstance(moduleId: ModuleId, instanceId: InstanceId): StoredSnapshot | undefined;
  /** Every stored row of a module. */
  ofModule(moduleId: ModuleId): StoredSnapshot[];
  /** Wire format with `stale` computed against `now()`. */
  toDto(snap: StoredSnapshot, instanceId: InstanceId): SnapshotDto;
  /** Flags the feeding job as failed (the snapshot becomes stale). No-op when nothing is stored. */
  markJobFailed(moduleId: ModuleId, instanceId: InstanceId | null): void;
}

interface Row {
  module_id: string;
  instance_id: string | null;
  data: string;
  updated_at: string;
  job_ok: number;
}

function fromRow(r: Row): StoredSnapshot {
  return {
    moduleId: r.module_id,
    instanceId: r.instance_id,
    data: JSON.parse(r.data) as unknown,
    updatedAt: r.updated_at,
    jobOk: r.job_ok !== 0,
  };
}

export function createSnapshots(deps: SnapshotsDeps): Snapshots {
  const { db } = deps;
  const upsert = db.prepare(
    `INSERT INTO snapshots (module_id, instance_id, data, updated_at, job_ok) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (module_id, coalesce(instance_id, ''))
     DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, job_ok = 1`,
  );
  const selOne = db.prepare(
    `SELECT * FROM snapshots WHERE module_id = ? AND coalesce(instance_id, '') = coalesce(?, '')`,
  );
  const selModule = db.prepare('SELECT * FROM snapshots WHERE module_id = ?');
  const failJob = db.prepare(
    `UPDATE snapshots SET job_ok = 0 WHERE module_id = ? AND coalesce(instance_id, '') = coalesce(?, '')`,
  );

  function get(moduleId: ModuleId, instanceId: InstanceId | null): StoredSnapshot | undefined {
    const r = selOne.get(moduleId, instanceId) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  function push(moduleId: ModuleId, instanceId: InstanceId | null, data: unknown): void {
    if (data === undefined) {
      deps.logger.warn({ module: moduleId }, 'snapshot rejected: undefined data');
      throw new DashError('invalid', 'Snapshot data must not be undefined');
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(data);
    } catch {
      json = undefined;
    }
    if (json === undefined) {
      deps.logger.warn({ module: moduleId }, 'snapshot rejected: not JSON serializable');
      throw new DashError('invalid', 'Snapshot data is not JSON serializable');
    }
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_SNAPSHOT_BYTES) {
      deps.logger.warn({ module: moduleId, bytes, max: MAX_SNAPSHOT_BYTES }, 'snapshot rejected: too large');
      throw new DashError('invalid', 'Snapshot exceeds 256 KB');
    }
    upsert.run(moduleId, instanceId, json, deps.now().toISOString());
    const stored = get(moduleId, instanceId);
    if (stored) deps.onStored(moduleId, instanceId, stored);
  }

  function staleThresholdSec(moduleId: ModuleId): number | undefined {
    const m = deps.manifests(moduleId);
    if (!m) return undefined;
    if (m.tile.staleAfterSec !== undefined) return m.tile.staleAfterSec;
    if (m.jobs.length === 0) return undefined;
    return 2.5 * Math.min(...m.jobs.map((j) => j.intervalSec));
  }

  function toDto(snap: StoredSnapshot, instanceId: InstanceId): SnapshotDto {
    const limit = staleThresholdSec(snap.moduleId);
    const ageSec = (deps.now().getTime() - Date.parse(snap.updatedAt)) / 1000;
    const stale = !snap.jobOk || (limit !== undefined && ageSec > limit);
    return { instanceId, data: snap.data, updatedAt: snap.updatedAt, stale };
  }

  return {
    push,
    get,
    forInstance: (moduleId, instanceId) => get(moduleId, instanceId) ?? get(moduleId, null),
    ofModule: (moduleId) => (selModule.all(moduleId) as Row[]).map(fromRow),
    toDto,
    markJobFailed: (moduleId, instanceId) => void failJob.run(moduleId, instanceId),
  };
}
