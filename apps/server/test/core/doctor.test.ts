/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import { formatDoctorReport, runDoctor, type DoctorProbes, type DoctorReport } from '../../src/core/doctor.ts';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);
const daysAhead = (d: number): Date => new Date(NOW.getTime() + d * 86_400_000);
const MB = 1_048_576;

function healthy(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    serviceState: async () => 'active',
    health: async () => ({ status: 200, ok: true }),
    diskFreeFraction: async () => 0.6,
    databaseIntegrity: async () => 'ok',
    lastBackup: async () => hoursAgo(3),
    certificate: async () => ({ expires: daysAhead(60), trusted: true }),
    jobFailures: async () => [{ module: 'weather', job: 'fetch', failures: 0 }],
    memory: async () => ({ currentBytes: 100 * MB, highBytes: 300 * MB }),
    tailscaleState: async () => 'Running',
    firewallActive: async () => true,
    pendingSecurityUpdates: async () => 0,
    ...over,
  };
}

async function run(over: Partial<DoctorProbes> = {}): Promise<DoctorReport> {
  return runDoctor(healthy(over), { now: NOW });
}
const statusOf = (r: DoctorReport, id: string): string => r.checks.find((c) => c.id === id)?.status ?? 'missing';
const boom = async (): Promise<never> => {
  throw new Error('probe broke');
};

describe('runDoctor thresholds', () => {
  it('all healthy: 11 checks OK, exit code 0', async () => {
    const r = await run();
    expect(r.checks).toHaveLength(11);
    expect(r.checks.every((c) => c.status === 'OK')).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('disk 10 % -> FAIL', async () => {
    const r = await run({ diskFreeFraction: async () => 0.1 });
    expect(statusOf(r, 'disk')).toBe('FAIL');
  });
  it('disk boundary: 15 % FAIL, just above OK', async () => {
    expect(statusOf(await run({ diskFreeFraction: async () => 0.15 }), 'disk')).toBe('FAIL');
    expect(statusOf(await run({ diskFreeFraction: async () => 0.151 }), 'disk')).toBe('OK');
  });

  it('backup 30 h -> WARN', async () => {
    const r = await run({ lastBackup: async () => hoursAgo(30) });
    expect(statusOf(r, 'backup')).toBe('WARN');
  });
  it('backup boundary: 25.9 h OK, 26 h WARN', async () => {
    expect(statusOf(await run({ lastBackup: async () => hoursAgo(25.9) }), 'backup')).toBe('OK');
    expect(statusOf(await run({ lastBackup: async () => hoursAgo(26) }), 'backup')).toBe('WARN');
  });
  it('no backups yet -> WARN', async () => {
    const r = await run({ lastBackup: async () => null });
    expect(statusOf(r, 'backup')).toBe('WARN');
    expect(r.checks.find((c) => c.id === 'backup')?.detail).toContain('no backups yet');
  });

  it('cert 5 days -> FAIL', async () => {
    const r = await run({ certificate: async () => ({ expires: daysAhead(5), trusted: true }) });
    expect(statusOf(r, 'certificate')).toBe('FAIL');
  });
  it('cert boundary: 14 days FAIL, 14.1 days OK', async () => {
    expect(statusOf(await run({ certificate: async () => ({ expires: daysAhead(14), trusted: true }) }), 'certificate')).toBe('FAIL');
    expect(statusOf(await run({ certificate: async () => ({ expires: daysAhead(14.1), trusted: true }) }), 'certificate')).toBe('OK');
  });
  it('an untrusted certificate is a FAIL even when far from expiry', async () => {
    const r = await run({ certificate: async () => ({ expires: daysAhead(60), trusted: false, problem: 'certificate has expired' }) });
    expect(statusOf(r, 'certificate')).toBe('FAIL');
  });

  it('jobs boundary: 4 failures OK, 5 failures WARN naming the job', async () => {
    expect(statusOf(await run({ jobFailures: async () => [{ module: 'a', job: 'x', failures: 4 }] }), 'jobs')).toBe('OK');
    const r = await run({ jobFailures: async () => [{ module: 'rss', job: 'poll', failures: 5 }] });
    expect(statusOf(r, 'jobs')).toBe('WARN');
    expect(r.checks.find((c) => c.id === 'jobs')?.detail).toContain('rss/poll');
  });

  it('memory boundary: below MemoryHigh OK, at MemoryHigh WARN', async () => {
    expect(statusOf(await run({ memory: async () => ({ currentBytes: 300 * MB - 1, highBytes: 300 * MB }) }), 'memory')).toBe('OK');
    expect(statusOf(await run({ memory: async () => ({ currentBytes: 300 * MB, highBytes: 300 * MB }) }), 'memory')).toBe('WARN');
    expect(statusOf(await run({ memory: async () => ({ currentBytes: 10 * MB, highBytes: null }) }), 'memory')).toBe('WARN');
  });

  it('service, health, database, tailscale, firewall, updates: both sides', async () => {
    expect(statusOf(await run({ serviceState: async () => 'inactive' }), 'service')).toBe('FAIL');
    expect(statusOf(await run({ health: async () => ({ status: 503, ok: false }) }), 'health')).toBe('FAIL');
    expect(statusOf(await run({ health: async () => ({ status: 200, ok: false }) }), 'health')).toBe('FAIL');
    expect(statusOf(await run({ databaseIntegrity: async () => '*** in database main ***\nPage 3 broken' }), 'database')).toBe('FAIL');
    expect(statusOf(await run({ tailscaleState: async () => 'NeedsLogin' }), 'tailscale')).toBe('FAIL');
    expect(statusOf(await run({ firewallActive: async () => false }), 'firewall')).toBe('WARN');
    expect(statusOf(await run({ pendingSecurityUpdates: async () => 1 }), 'updates')).toBe('WARN');
  });
});

describe('runDoctor failing probes', () => {
  it.each(['diskFreeFraction', 'lastBackup', 'certificate', 'jobFailures', 'memory', 'tailscaleState', 'firewallActive', 'pendingSecurityUpdates'] as const)(
    'a throwing %s probe gives WARN with the reason',
    async (name) => {
      const r = await run({ [name]: boom });
      const warned = r.checks.filter((c) => c.status === 'WARN');
      expect(warned).toHaveLength(1);
      expect(warned[0]?.detail).toContain('probe broke');
      expect(r.exitCode).toBe(0);
    },
  );

  it.each(['serviceState', 'health', 'databaseIntegrity'] as const)('a throwing %s probe gives FAIL and exit code 1', async (name) => {
    const r = await run({ [name]: boom });
    const failed = r.checks.filter((c) => c.status === 'FAIL');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('probe broke');
    expect(r.exitCode).toBe(1);
  });

  it('one FAIL gives exit code 1; a WARN alone gives 0', async () => {
    expect((await run({ diskFreeFraction: async () => 0.05 })).exitCode).toBe(1);
    expect((await run({ lastBackup: async () => null })).exitCode).toBe(0);
  });
});

describe('formatDoctorReport', () => {
  it('prints aligned lines, status first, and a summary; no colour codes', async () => {
    const r = await run({ lastBackup: async () => hoursAgo(30), diskFreeFraction: async () => 0.1 });
    const text = formatDoctorReport(r, { color: false });
    const lines = text.split('\n');
    expect(lines).toHaveLength(r.checks.length + 2);
    expect(lines[0]).toBe(`OK    ${'Service active'.padEnd(18)}  dashboard.service is active`);
    expect(lines.find((l) => l.startsWith('FAIL'))).toContain('Disk space');
    expect(lines.find((l) => l.startsWith('WARN'))).toContain('Last backup');
    expect(lines.at(-1)).toBe('9 OK, 1 WARN, 1 FAIL');
    expect(text).not.toContain('\u001b');
    // every check line has the detail column at the same offset
    for (const l of lines.slice(0, r.checks.length)) expect(l.slice(24, 26) === '  ' && l[26] !== ' ').toBe(true);
  });

  it('adds colour codes only when asked', async () => {
    const text = formatDoctorReport(await run(), { color: true });
    expect(text).toContain('\u001b[32m');
  });

  it('JSON shape: checks with id/label/status/detail and exitCode', async () => {
    const parsed = JSON.parse(JSON.stringify(await run({ lastBackup: async () => null }))) as DoctorReport;
    expect(Object.keys(parsed).sort()).toEqual(['checks', 'exitCode']);
    expect(parsed.checks.map((c) => c.id)).toEqual([
      'service', 'health', 'disk', 'database', 'backup', 'certificate', 'jobs', 'memory', 'tailscale', 'firewall', 'updates',
    ]);
    for (const c of parsed.checks) expect(Object.keys(c).sort()).toEqual(['detail', 'id', 'label', 'status']);
  });
});
