/* eslint-disable @typescript-eslint/require-await */
// Module setup/teardown lifecycle: who gets torn down, and the time bounds on both hooks.
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostServices } from '@dash/contract';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import {
  loadModules,
  SETUP_TIMEOUT_MS,
  teardownModules,
  TEARDOWN_TIMEOUT_MS,
} from '../../src/core/modules/loader.ts';
import { start } from '../../src/main.ts';
import { serverFor, silentLogger } from './module-env.ts';

afterEach(() => {
  vi.useRealTimers();
});

async function load(servers: Array<ReturnType<typeof serverFor>>, disabled: string[] = []) {
  const db = openDb(':memory:');
  migrateCore(db);
  for (const id of disabled) db.prepare('INSERT INTO module_state (module_id, enabled) VALUES (?, 0)').run(id);
  return loadModules(
    servers.map((s) => async () => ({ default: s })),
    db,
    { logger: silentLogger, makeHost: () => ({}) as HostServices },
  );
}

describe('teardown only for set-up modules', () => {
  it('does not tear down a module that was disabled at start', async () => {
    const teardown = vi.fn();
    const off = serverFor('off', undefined, { setup: vi.fn(), teardown });
    const on = serverFor('on', undefined, { setup: vi.fn(), teardown: vi.fn() });
    const modules = await load([off, on], ['off']);
    expect(modules.map((m) => m.setupRan)).toEqual([false, true]);
    await teardownModules(modules, silentLogger);
    expect(teardown).not.toHaveBeenCalled();
    expect(on.teardown).toHaveBeenCalledOnce();
  });
});

describe('time bounds', () => {
  it('a hanging setup marks only that module failed after the limit; the others load', async () => {
    vi.useFakeTimers();
    const teardown = vi.fn();
    const hang = serverFor('hang', undefined, { setup: () => new Promise<void>(() => {}), teardown });
    const fine = serverFor('fine', undefined, { setup: vi.fn() });
    const pending = load([hang, fine]);
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    const modules = await pending;
    expect(modules[0]!.failed).toMatch(/setup failed: setup timed out/);
    expect(modules[1]!.failed).toBeUndefined();
    await teardownModules(modules, silentLogger);
    expect(teardown).not.toHaveBeenCalled();
  });

  it('a hanging teardown is abandoned and does not stop the other modules', async () => {
    const hang = serverFor('hang', undefined, { teardown: () => new Promise<void>(() => {}) });
    const second = serverFor('second', undefined, { teardown: vi.fn() });
    const modules = await load([hang, second]);
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const done = teardownModules(modules, { ...silentLogger, error: (...a: unknown[]) => void errors.push(a) });
    await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS);
    await done;
    expect(second.teardown).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });
});

describe('start() failure after compose', () => {
  it('calls teardown for modules that were set up', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const mod = serverFor('hooked', undefined, { setup: vi.fn(), teardown: vi.fn() });
    const root = mkdtempSync(join(tmpdir(), 'dash-life-'));
    try {
      await expect(
        start(
          { NODE_ENV: 'test', DASH_DATA_DIR: join(root, 'd'), DASH_CONFIG_DIR: join(root, 'c'), DASH_PORT: String(port) },
          { logger: false, registry: [() => Promise.resolve({ default: mod })] },
        ),
      ).rejects.toThrow();
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
    expect(mod.setup).toHaveBeenCalledOnce();
    expect(mod.teardown).toHaveBeenCalledOnce();
  });
});
