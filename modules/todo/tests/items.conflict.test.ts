import { describe, expect, it } from 'vitest';
import type { WireItem } from '../manifest.js';
import { add, as, listOf, setup } from './helpers.js';

describe('optimistic concurrency', () => {
  it('PATCH with old version → 409, item unchanged', async () => {
    const { router } = await setup();
    const item = await add(router, 'u1', { title: 'Original' });
    const ok = await router.call('PATCH', `/items/${item.id}`, { ...as('u1'), body: { version: item.version, title: 'Second' } });
    expect(ok.status).toBe(200);
    const stale = await router.call('PATCH', `/items/${item.id}`, { ...as('u1'), body: { version: item.version, title: 'Lost' } });
    expect(stale.status).toBe(409);
    const details = (stale.body as { error: { code: string; details: { item: WireItem } } }).error;
    expect(details.code).toBe('conflict');
    expect(details.details.item.title).toBe('Second');
    expect(details.details.item.version).toBe(item.version + 1);
    const now = (await listOf(router, 'u1')).items.find((i) => i.id === item.id);
    expect(now?.title).toBe('Second');
    expect(now?.version).toBe(item.version + 1);
  });

  it('two concurrent done calls: one wins, one 409', async () => {
    const { router } = await setup();
    const item = await add(router, 'u1', { list: 'shopping', title: 'Milk' });
    const call = (user: string) => router.call('POST', `/items/${item.id}/done`, { ...as(user), body: { version: item.version, done: true } });
    const results = await Promise.all([call('u1'), call('u2')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect((loser.body as { error: { details: { item: WireItem } } }).error.details.item.done).toBe(true);
    const now = (await listOf(router, 'u1')).items.find((i) => i.id === item.id);
    expect(now?.version).toBe(item.version + 1); // bumped exactly once
  });

  it('DELETE with an old version → 409 and the item stays; the version may come in the query', async () => {
    const { router } = await setup();
    const item = await add(router, 'u1', { title: 'Keep' });
    await router.call('PATCH', `/items/${item.id}`, { ...as('u1'), body: { version: item.version, note: 'n' } });
    expect((await router.call('DELETE', `/items/${item.id}`, { ...as('u1'), body: { version: item.version } })).status).toBe(409);
    expect((await listOf(router, 'u1')).items).toHaveLength(1);
    expect((await router.call('DELETE', `/items/${item.id}`, { ...as('u1'), query: { version: String(item.version + 1) } })).status).toBe(200);
    expect((await listOf(router, 'u1')).items).toHaveLength(0);
  });
});
