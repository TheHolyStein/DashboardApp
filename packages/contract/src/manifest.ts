import { z } from 'zod';
import { events, type EventName } from './events.js';
import { GRID_COLUMNS, ID_RE, type ModuleId, type TileSize } from './ids.js';

export interface JobSpec {
  name: string;                         // unique within module
  intervalSec: number;                  // >= 5
  mode: 'always' | 'whenViewed';
  per: 'instance' | 'module';
  timeoutSec?: number;                  // default 30
}
export type OutboundRule =
  | { kind: 'host'; host: string }      // exact hostname, https only
  | { kind: 'publicUrl' }               // user-supplied URL, must resolve public
  | { kind: 'lanDevice' };              // admin-configured private address
export interface RootMount { prefix: string; auth: 'session' | 'appPassword' }
export interface ModuleManifest<
  S extends z.ZodType = z.ZodType,      // per-instance settings
  C extends z.ZodType = z.ZodType       // module-wide admin config
> {
  id: ModuleId;
  name: string;                         // English fallback; shown via t(`module.${id}.name`, name)
  description: string;
  version: string;                      // semver
  icon: string;                         // icon key, see theme.ts ICON_KEYS or module-provided svg key
  scope: 'user' | 'shared';
  multiInstance: boolean;
  tile: { default: TileSize; min: TileSize; max: TileSize; staleAfterSec?: number };
  settings: S;
  config: C;
  levels: ReadonlyArray<'view' | 'edit'>;   // which grants make sense
  jobs: ReadonlyArray<JobSpec>;
  publishes: ReadonlyArray<EventName>;
  subscribes: ReadonlyArray<EventName>;
  outbound: ReadonlyArray<OutboundRule>;
  rootMounts?: ReadonlyArray<RootMount>;    // core allowlists these per module id
}

export const SEMVER_RE =/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function sizeWithin(size: TileSize, lo: TileSize, hi: TileSize): boolean {
  return size.w >= lo.w && size.h >= lo.h && size.w <= hi.w && size.h <= hi.h;
}

// Returns human-readable problems; [] means valid.
export function validateManifest(m: ModuleManifest): string[] {
  const problems: string[] = [];

  if (!ID_RE.test(m.id)) problems.push(`id "${m.id}" does not match ${ID_RE}`);
  if (!SEMVER_RE.test(m.version)) problems.push(`version "${m.version}" is not semver`);

  const { tile } = m;
  if (!sizeWithin(tile.default, tile.min, tile.max)) {
    problems.push('tile must satisfy min <= default <= max');
  }
  if (tile.max.w > GRID_COLUMNS) {
    problems.push(`tile max width ${tile.max.w} exceeds ${GRID_COLUMNS} grid columns`);
  }

  const seenJobs = new Set<string>();
  for (const job of m.jobs) {
    if (seenJobs.has(job.name)) problems.push(`duplicate job name "${job.name}"`);
    seenJobs.add(job.name);
    if (job.intervalSec < 5) problems.push(`job "${job.name}" intervalSec must be >= 5`);
  }

  for (const rule of m.outbound) {
    if (rule.kind === 'host' && /[:/]/.test(rule.host)) {
      problems.push(`host rule "${rule.host}" must be a bare hostname (no scheme or path)`);
    }
  }

  for (const name of [...m.publishes, ...m.subscribes]) {
    if (!Object.hasOwn(events, name)) problems.push(`unknown event "${name}"`);
  }

  if (!(m.settings instanceof z.ZodObject)) problems.push('settings must be a z.object');
  if (!(m.config instanceof z.ZodObject)) problems.push('config must be a z.object');

  return problems;
}
