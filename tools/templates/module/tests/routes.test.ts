import { describe, expect, it } from 'vitest';
import { createMockHostWithSetup, createMockRouter } from '@dash/module-kit/testing';
import server from '../server/index.js';

async function setup() {
  const host = await createMockHostWithSetup(server); // applies the migrations, then runs setup (creates the pusher)
  return { host, router: createMockRouter(server, host) };
}

describe('items routes', () => {
  it('creates an item with a time-ordered id and pushes one snapshot', async () => {
    const { host, router } = await setup();
    const res = await router.call('POST', '/items', { level: 'edit', body: { label: 'First' } });
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(host.pushed).toEqual([{ instanceId: null, data: { value: 1, label: 'First' } }]);
  });

  it('the instance route needs an instance the caller may see', async () => {
    const { host, router } = await setup();
    host.setInstances([{ id: 'i1', ownerId: 'u1', pageId: 'p1', settings: {} }, { id: 'i2', ownerId: 'u2', pageId: 'p2', settings: {} }]);
    expect((await router.call('GET', '/instance', { level: 'view', instance: 'i1' })).body).toEqual({ instanceId: 'i1', settings: {} });
    expect((await router.call('GET', '/instance', { level: 'view', instance: 'i2' })).status).toBe(404);
    expect((await router.call('GET', '/instance', { level: 'view' })).status).toBe(404);
  });

  it('rejects an invalid body with 422 and a viewer with 403', async () => {
    const { router } = await setup();
    expect((await router.call('POST', '/items', { level: 'edit', body: { label: '' } })).status).toBe(422);
    expect((await router.call('POST', '/items', { level: 'view', body: { label: 'x' } })).status).toBe(403);
  });

  it('delete answers 204 and an unchanged snapshot is not pushed twice', async () => {
    const { host, router } = await setup();
    expect((await router.call('DELETE', '/items/none', { level: 'edit' })).status).toBe(204);
    expect((await router.call('DELETE', '/items/none', { level: 'edit' })).status).toBe(204);
    expect(host.pushed).toHaveLength(1);
  });
});
