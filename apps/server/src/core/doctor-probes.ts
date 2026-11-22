/* eslint-disable @typescript-eslint/require-await */
// Real probes for `doctor`. Read-only: fixed argument arrays through execFile (never a shell,
// never input-derived arguments), short timeouts, nothing is changed.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { promisify } from 'node:util';
import BetterSqlite3 from 'better-sqlite3';
import type { AppConfig } from '../seams.js';
import { loadConfig } from './config.js';
import { formatDoctorReport, runDoctor, type DoctorProbes } from './doctor.js';

const exec = promisify(execFile);

/** Runs a command; resolves with stdout even on a non-zero exit (systemctl is-active exits 3). */
async function run(cmd: string, args: string[], timeout = 10_000): Promise<{ stdout: string; code: number }> {
  try {
    const r = await exec(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 4_000_000 });
    return { stdout: r.stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; message: string };
    if (typeof e.code === 'number') return { stdout: e.stdout ?? '', code: e.code };
    throw new Error(e.code === 'ENOENT' ? `${cmd} is not installed` : e.message, { cause: err });
  }
}

function openReadOnly(config: AppConfig): BetterSqlite3.Database {
  return new BetterSqlite3(join(config.dataDir, 'dashboard.sqlite'), { readonly: true, fileMustExist: true });
}

function withDb<T>(config: AppConfig, fn: (db: BetterSqlite3.Database) => T): T {
  const db = openReadOnly(config);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function createProbes(config: AppConfig, env: NodeJS.ProcessEnv): DoctorProbes {
  return {
    serviceState: async () => (await run('systemctl', ['is-active', 'dashboard'])).stdout.trim() || 'unknown',

    health: () =>
      new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: config.port, path: '/api/health', timeout: 5000 }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => (body += d));
          res.on('end', () => {
            let ok = false;
            try {
              ok = (JSON.parse(body) as { ok?: unknown }).ok === true;
            } catch {
              /* not JSON: ok stays false */
            }
            resolve({ status: res.statusCode ?? 0, ok });
          });
        });
        req.on('timeout', () => req.destroy(new Error('no answer within 5 s')));
        req.on('error', reject);
        req.end();
      }),

    diskFreeFraction: async () => {
      const s = statfsSync(config.dataDir);
      return s.blocks === 0 ? 0 : s.bavail / s.blocks;
    },

    databaseIntegrity: async () =>
      withDb(config, (db) => (db.pragma('integrity_check') as Array<{ integrity_check: string }>).map((r) => r.integrity_check).join('\n')),

    lastBackup: async () => {
      const dir = join(config.dataDir, 'backups');
      let newest = 0;
      if (!existsSync(dir)) return null;
      for (const f of readdirSync(dir)) {
        const st = statSync(join(dir, f));
        if (f.endsWith('.sqlite') && st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
      }
      return newest === 0 ? null : new Date(newest);
    },

    certificate: () =>
      new Promise((resolve, reject) => {
        const url = new URL(config.baseUrl);
        if (url.protocol !== 'https:') return reject(new Error('DASH_BASE_URL is not https'));
        const port = url.port === '' ? 443 : Number(url.port);
        // Verification stays on (socket.authorized); a verification failure is reported rather than
        // thrown, so an expired certificate becomes a FAIL with its reason instead of an unknown.
        const sock = connect({ host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false, timeout: 5000 }, () => {
          const expires = new Date(sock.getPeerCertificate().valid_to);
          const problem = sock.authorizationError ? String(sock.authorizationError) : undefined;
          const trusted = sock.authorized;
          sock.end();
          if (Number.isNaN(expires.getTime())) return reject(new Error('no certificate expiry in the handshake'));
          resolve({ expires, trusted, ...(problem ? { problem } : {}) });
        });
        sock.on('timeout', () => sock.destroy(new Error('no TLS answer within 5 s')));
        sock.on('error', reject);
      }),

    jobFailures: async () =>
      withDb(config, (db) =>
        (db.prepare('SELECT module_id, job, failures FROM job_state WHERE failures > 0').all() as Array<{ module_id: string; job: string; failures: number }>).map(
          (r) => ({ module: r.module_id, job: r.job, failures: r.failures }),
        ),
      ),

    memory: async () => {
      const { stdout } = await run('systemctl', ['show', 'dashboard', '-p', 'MemoryCurrent', '-p', 'MemoryHigh']);
      const v = (k: string): string =>
        stdout.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '';
      if (!/^\d+$/.test(v('MemoryCurrent'))) throw new Error('systemd reports no MemoryCurrent (is the service running?)');
      return {
        currentBytes: Number(v('MemoryCurrent')),
        highBytes: /^\d+$/.test(v('MemoryHigh')) ? Number(v('MemoryHigh')) : null,
      };
    },

    tailscaleState: async () => {
      const { stdout } = await run('tailscale', ['status', '--json']);
      const state = (JSON.parse(stdout) as { BackendState?: unknown }).BackendState;
      if (typeof state !== 'string') throw new Error('tailscale status has no BackendState');
      return state;
    },

    firewallActive: async () => {
      // deploy/doctor.sh runs as root, reads `ufw status` there and hands the text over, because
      // the CLI itself runs as the unprivileged service user.
      let text = env['DASH_DOCTOR_UFW_STATUS'];
      if (text === undefined) {
        const r = await run('ufw', ['status']);
        if (r.code !== 0 || !/^Status:/m.test(r.stdout)) throw new Error('run as root to check (sudo deploy/doctor.sh)');
        text = r.stdout;
      }
      return /^Status:\s*active/im.test(text);
    },

    pendingSecurityUpdates: async () => {
      const { stdout, code } = await run('apt-get', ['-s', 'upgrade'], 30_000);
      if (code !== 0 && !/^Inst /m.test(stdout)) throw new Error('apt-get -s upgrade could not run');
      return stdout.split('\n').filter((l) => l.startsWith('Inst ') && /-security\b|Debian-Security/i.test(l)).length;
    },
  };
}

/** `doctor [--json]`: prints the report and returns the exit code. */
export async function doctorMain(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const json = args.includes('--json');
  if (args.some((a) => a !== '--json')) throw new Error('Usage: cli doctor [--json]');
  const report = await runDoctor(createProbes(loadConfig(env), env), { now: new Date() });
  const color = process.stdout.isTTY && env['NO_COLOR'] === undefined;
  console.log(json ? JSON.stringify(report, null, 2) : formatDoctorReport(report, { color }));
  return report.exitCode;
}
