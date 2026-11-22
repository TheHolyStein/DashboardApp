import { createMockHostWithSetup, createMockRouter, type MockHost, type MockRouter } from '@dash/module-kit/testing';
import type { ModuleInstance } from '@dash/contract';
import server from '../server/index.js';
import type { ItemList, WireItem } from '../manifest.js';

export const NOW = new Date('2026-11-18T09:00:00Z'); // a Wednesday
export const USERS = [
  { id: 'u1', name: 'Dana', handle: 'dani', role: 'admin' as const, timeZone: 'UTC' },
  { id: 'u2', name: 'Eli', handle: 'eli', role: 'member' as const, timeZone: 'UTC' },
  { id: 'u3', name: 'Fay', handle: 'fay', role: 'member' as const, timeZone: 'UTC' },
];

export async function setup(instances: ModuleInstance[] = []): Promise<{ host: MockHost; router: MockRouter }> {
  const host = await createMockHostWithSetup(server, {
    now: NOW,
    prepare: (h) => {
      h.setUsers(USERS);
      h.setInstances(instances);
    },
  });
  return { host, router: createMockRouter(server, host) };
}

export const as = (userId: string, level: 'view' | 'edit' = 'edit') => ({ level, user: { id: userId, name: userId } });

/** Creates an item through the API and returns it. */
export async function add(
  router: MockRouter,
  userId: string,
  body: Record<string, unknown>,
): Promise<WireItem> {
  const res = await router.call('POST', '/items', { ...as(userId), body: { list: 'week', title: 'Task', ...body } });
  if (res.status !== 200) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  const list = res.body as ItemList;
  const found = list.items.find((i) => i.id === (res.body as { itemId: string }).itemId);
  if (!found) throw new Error('created item missing from the answer');
  return found;
}

export async function listOf(router: MockRouter, userId: string, query?: Record<string, string>): Promise<ItemList> {
  const res = await router.call('GET', '/items', { ...as(userId, 'view'), ...(query ? { query } : {}) });
  return res.body as ItemList;
}
