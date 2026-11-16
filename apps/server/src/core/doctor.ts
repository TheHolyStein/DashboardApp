// `doctor`: one line per health check. Probes only fetch facts; every threshold and every
// OK/WARN/FAIL decision lives in runDoctor so it can be tested with injected probes.

export type DoctorStatus = 'OK' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  exitCode: 0 | 1;
}

export interface DoctorProbes {
  /** systemd state of the dashboard unit, e.g. 'active', 'inactive', 'failed'. */
  serviceState(): Promise<string>;
  /** Result of GET /api/health on loopback: HTTP status and whether the body said ok. */
  health(): Promise<{ status: number; ok: boolean }>;
  /** Free fraction (0..1) of the file system that holds the data directory. */
  diskFreeFraction(): Promise<number>;
  /** Output of PRAGMA integrity_check ('ok' when healthy). */
  databaseIntegrity(): Promise<string>;
  /** Time of the newest file in the backups directory, or null when there is none. */
  lastBackup(): Promise<Date | null>;
  /** Certificate of the base URL host: expiry and whether it verified. */
  certificate(): Promise<{ expires: Date; trusted: boolean; problem?: string }>;
  /** Jobs and their consecutive failure counts. */
  jobFailures(): Promise<Array<{ module: string; job: string; failures: number }>>;
  /** Bytes in use and the MemoryHigh limit (null when the unit has no limit). */
  memory(): Promise<{ currentBytes: number; highBytes: number | null }>;
  /** Tailscale BackendState, e.g. 'Running', 'Stopped', 'NeedsLogin'. */
  tailscaleState(): Promise<string>;
  /** Whether the firewall is active. */
  firewallActive(): Promise<boolean>;
  /** Number of pending upgrades that come from a security repository. */
  pendingSecurityUpdates(): Promise<number>;
}

export const THRESHOLDS = {
  diskFreeMin: 0.15,
  backupMaxAgeHours: 26,
  certMinDays: 14,
  jobFailuresMax: 5,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Outcome = { status: DoctorStatus; detail: string };

interface Def {
  id: string;
  label: string;
  /** Status when the probe throws: FAIL only for the checks that mean the dashboard is down. */
  onError: 'WARN' | 'FAIL';
  run(p: DoctorProbes, now: Date): Promise<Outcome>;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
const mb = (b: number): string => `${Math.round(b / 1_048_576)} MB`;
const out = (status: DoctorStatus, detail: string): Outcome => ({ status, detail });

const DEFS: Def[] = [
  {
    id: 'service', label: 'Service active', onError: 'FAIL',
    run: async (p) => {
      const s = await p.serviceState();
      return s === 'active' ? out('OK', 'dashboard.service is active') : out('FAIL', `dashboard.service is ${s}`);
    },
  },
  {
    id: 'health', label: 'Health endpoint', onError: 'FAIL',
    run: async (p) => {
      const h = await p.health();
      return h.status === 200 && h.ok
        ? out('OK', '/api/health answered ok')
        : out('FAIL', `/api/health answered HTTP ${h.status}${h.ok ? '' : ' without ok'}`);
    },
  },
  {
    id: 'disk', label: 'Disk space', onError: 'WARN',
    run: async (p) => {
      const f = await p.diskFreeFraction();
      return f > THRESHOLDS.diskFreeMin
        ? out('OK', `${pct(f)} free`)
        : out('FAIL', `only ${pct(f)} free (need more than ${pct(THRESHOLDS.diskFreeMin)})`);
    },
  },
  {
    id: 'database', label: 'Database integrity', onError: 'FAIL',
    run: async (p) => {
      const r = (await p.databaseIntegrity()).trim();
      return r === 'ok' ? out('OK', 'integrity_check ok') : out('FAIL', `integrity_check: ${r.split('\n')[0] ?? r}`);
    },
  },
  {
    id: 'backup', label: 'Last backup', onError: 'WARN',
    run: async (p, now) => {
      const t = await p.lastBackup();
      if (t === null) return out('WARN', 'no backups yet (the installer makes one before each update)');
      const hours = (now.getTime() - t.getTime()) / HOUR_MS;
      const text = `${hours.toFixed(1)} h ago`;
      return hours < THRESHOLDS.backupMaxAgeHours ? out('OK', text) : out('WARN', `${text} (limit ${THRESHOLDS.backupMaxAgeHours} h)`);
    },
  },
  {
    id: 'certificate', label: 'Certificate', onError: 'WARN',
    run: async (p, now) => {
      const c = await p.certificate();
      if (!c.trusted) return out('FAIL', `certificate not trusted: ${c.problem ?? 'unknown reason'}`);
      const days = (c.expires.getTime() - now.getTime()) / DAY_MS;
      const text = `expires in ${days.toFixed(1)} days`;
      return days > THRESHOLDS.certMinDays ? out('OK', text) : out('FAIL', `${text} (need more than ${THRESHOLDS.certMinDays})`);
    },
  },
  {
    id: 'jobs', label: 'Background jobs', onError: 'WARN',
    run: async (p) => {
      const bad = (await p.jobFailures()).filter((j) => j.failures >= THRESHOLDS.jobFailuresMax);
      if (bad.length === 0) return out('OK', 'no job failing repeatedly');
      return out('WARN', bad.map((j) => `${j.module}/${j.job} failed ${j.failures} times`).join(', '));
    },
  },
  {
    id: 'memory', label: 'Memory', onError: 'WARN',
    run: async (p) => {
      const m = await p.memory();
      if (m.highBytes === null) return out('WARN', `${mb(m.currentBytes)} in use; MemoryHigh is not set`);
      const text = `${mb(m.currentBytes)} of ${mb(m.highBytes)} (MemoryHigh)`;
      return m.currentBytes < m.highBytes ? out('OK', text) : out('WARN', `${text}: at or over the limit`);
    },
  },
  {
    id: 'tailscale', label: 'Tailscale', onError: 'WARN',
    run: async (p) => {
      const s = await p.tailscaleState();
      return s === 'Running' ? out('OK', 'connected') : out('FAIL', `state is ${s}; the dashboard cannot be reached`);
    },
  },
  {
    id: 'firewall', label: 'Firewall', onError: 'WARN',
    run: async (p) => ((await p.firewallActive()) ? out('OK', 'ufw is active') : out('WARN', 'ufw is not active')),
  },
  {
    id: 'updates', label: 'Security updates', onError: 'WARN',
    run: async (p) => {
      const n = await p.pendingSecurityUpdates();
      return n === 0 ? out('OK', 'none pending') : out('WARN', `${n} pending`);
    },
  },
];

export async function runDoctor(probes: DoctorProbes, opts: { now: Date }): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  for (const d of DEFS) {
    let r: Outcome;
    try {
      r = await d.run(probes, opts.now);
    } catch (err) {
      r = out(d.onError, `cannot determine: ${err instanceof Error ? err.message : String(err)}`);
    }
    checks.push({ id: d.id, label: d.label, status: r.status, detail: r.detail });
  }
  return { checks, exitCode: checks.some((c) => c.status === 'FAIL') ? 1 : 0 };
}

const COLORS: Record<DoctorStatus, string> = { OK: '\u001b[32m', WARN: '\u001b[33m', FAIL: '\u001b[31m' };

export function formatDoctorReport(report: DoctorReport, opts: { color: boolean }): string {
  const width = Math.max(0, ...report.checks.map((c) => c.label.length));
  const lines = report.checks.map((c) => {
    const tag = c.status.padEnd(4);
    const shown = opts.color ? `${COLORS[c.status]}${tag}\u001b[0m` : tag;
    return `${shown}  ${c.label.padEnd(width)}  ${c.detail}`;
  });
  const n = (s: DoctorStatus): number => report.checks.filter((c) => c.status === s).length;
  lines.push('', `${n('OK')} OK, ${n('WARN')} WARN, ${n('FAIL')} FAIL`);
  return lines.join('\n');
}
