import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createMockHostWithSetup, createMockRouter, serverContractCases } from '../src/testing.js';
import { defineServer } from '../src/index.js';
import { goodManifest } from './sample-module/good/manifest.js';

/** A server whose job and route need state created in `setup` (closure, not module scope). */
function stateful() {
  let state: { pushes: number } | undefined;
  const calls: string[] = [];
  const server = defineServer({
    manifest: goodManifest,
    setup(host) {
      calls.push(`setup:${host.moduleId}`);
      state = { pushes: 0 };
    },
    jobs: {
      refresh: ({ host }) => {
        if (!state) return Promise.reject(new Error('setup did not run before the job'));
        state.pushes += 1;
        host.push(null, { value: state.pushes, label: 'x' });
        return Promise.resolve();
      },
    },
    routes(r) {
      r.get('/state', { level: 'view', query: z.object({}) }, () => {
        if (!state) throw new Error('setup did not run before the route');
        return { pushes: state.pushes };
      });
    },
  });
  return { server, calls };
}

describe('setup hook in the kit', () => {
  test('createMockHostWithSetup runs setup once, after migrations and prepare', async () => {
    const { server, calls } = stateful();
    const order: string[] = [];
    const host = await createMockHostWithSetup(server, { prepare: () => void order.push('prepare') });
    expect(calls).toEqual([`setup:${goodManifest.id}`]);
    expect(order).toEqual(['prepare']);
    const router = createMockRouter(server, host);
    expect((await router.call('GET', '/state', { level: 'view' })).status).toBe(200);
  });

  test('the server contract suite runs setup before jobs and routes', async () => {
    const { server, calls } = stateful();
    const cases = serverContractCases(server, { moduleDir: import.meta.dirname, happyHttp: () => undefined });
    for (const name of ['every route declares a level', 'job publishes only declared events']) {
      await cases.find((c) => c.name === name)!.run();
    }
    expect(calls.length).toBe(2);
  });
});
