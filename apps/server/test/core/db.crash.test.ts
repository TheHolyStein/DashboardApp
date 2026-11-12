import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/db.ts';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crash-writer.ts');
const BATCH = 10; // must match the fixture

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('crash safety', () => {
  it('database survives SIGKILL during writes', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dash-crash-'));
    const file = path.join(dir, 'crash.db');

    const child = spawn(process.execPath, [fixture, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      // Start the 300 ms clock once the child is up, so slow node startup cannot yield zero commits.
      if (killTimer === undefined && out.includes('ready\n')) {
        killTimer = setTimeout(() => child.kill('SIGKILL'), 300);
      }
    });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (_code, sig) => resolve(sig));
    });
    clearTimeout(killTimer);
    expect(signal).toBe('SIGKILL');

    // Only fully received lines (terminated by \n) count; a trailing partial line is dropped.
    const lines = out.split('\n').slice(0, -1);
    const last = (tag: 'intent' | 'done'): number => {
      const hit = lines.filter((l) => l.startsWith(`${tag} `)).at(-1);
      return hit === undefined ? 0 : Number(hit.slice(tag.length + 1));
    };
    const lastDone = last('done');
    const lastIntent = last('intent');
    expect(lastDone).toBeGreaterThan(0);

    const db = openDb(file);
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      const { c } = db.prepare('SELECT count(*) AS c FROM crash_rows').get() as { c: number };
      // Exact: the kill either landed before COMMIT (count = last `done`) or between COMMIT and
      // the `done` line (count = last `intent`). Never a partial batch, never a lost commit.
      expect([lastDone, lastIntent]).toContain(c);
      expect(c % BATCH).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);
});
