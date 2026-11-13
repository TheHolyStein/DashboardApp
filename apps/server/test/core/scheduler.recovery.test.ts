/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createScheduler } from '../../src/core/scheduler.ts';
import { jobModule, silentLogger } from './module-env.ts';

const START = Date.parse('2026-11-12T10:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

it('20 overdue jobs after downtime are spread over at least 20 s, not started in the same second', async () => {
  const db = openDb(':memory:');
  migrateCore(db);
  // every job was due 10 minutes before the restart
  const overdue = new Date(START - 600_000).toISOString();
  const ins = db.prepare(
    "INSERT INTO job_state (module_id, job, instance_id, last_run_at, failures, next_run_at) VALUES ('m', ?, '', ?, 0, ?)",
  );
  for (let i = 0; i < 20; i++) ins.run(`j${i}`, overdue, overdue);

  const starts: number[] = [];
  let n = 0;
  const sched = createScheduler({
    db,
    now: () => new Date(Date.now()),
    random: () => (n++ % 20) / 20 + 0.0125, // deterministic, evenly spread over [0,1)
    instances: () => [],
    logger: silentLogger,
    maxConcurrent: 20,
  });
  sched.register(
    jobModule(
      'm',
      Array.from({ length: 20 }, (_, i) => ({
        name: `j${i}`,
        intervalSec: 300,
        run: async () => void starts.push(Date.now() - START),
      })),
    ),
  );
  sched.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toHaveLength(0); // nothing starts at once
  await vi.advanceTimersByTimeAsync(60_000);
  expect(starts).toHaveLength(20);
  expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThanOrEqual(20_000);
  const perSecond = new Map<number, number>();
  for (const s of starts) perSecond.set(Math.floor(s / 1000), (perSecond.get(Math.floor(s / 1000)) ?? 0) + 1);
  expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(2);
  await sched.stop();
});

it('never-run jobs get the same spread: random() x min(intervalSec, 60) s', () => {
  const db = openDb(':memory:');
  migrateCore(db);
  const sched = createScheduler({ db, now: () => new Date(Date.now()), random: () => 0.5, instances: () => [], logger: silentLogger });
  sched.register(jobModule('m', [{ name: 'a', intervalSec: 10 }, { name: 'b', intervalSec: 3600 }]));
  sched.start();
  const next = Object.fromEntries(sched.status().map((s) => [s.job, (Date.parse(s.nextRunAt!) - START) / 1000]));
  expect(next).toEqual({ a: 5, b: 30 });
});
