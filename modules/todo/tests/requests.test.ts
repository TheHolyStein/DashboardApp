import { describe, expect, it } from 'vitest';
import type { EventPayload } from '@dash/contract';
import server from '../server/index.js';
import { add, as, listOf, setup } from './helpers.js';

type Create = EventPayload<'todo.create.request'>;
const create = (over: Partial<Create> = {}): Create => ({
  sourceKey: 'cal:evt-1',
  list: 'deadline',
  title: 'Prepare slides',
  due: '2026-11-20T15:00:00Z',
  assigneeId: null,
  icon: null,
  url: null,
  ...over,
});
const handle = <E extends 'todo.create.request' | 'todo.remove.request' | 'item.readLater'>(e: E) => server.on![e]! as (p: EventPayload<E>, h: never) => Promise<void>;

describe('todo.create.request', () => {
  it('same sourceKey twice → one item', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create(), host as never);
    await handle('todo.create.request')(create(), host as never);
    const { items } = await listOf(router, 'u1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Prepare slides', list: 'deadline', due: '2026-11-20T15:00:00.000Z', visibility: 'shared' });
    expect(host.published.filter((p) => p.name === 'todo.changed')).toEqual([
      { name: 'todo.changed', payload: { itemId: items[0]!.id, kind: 'created' } },
    ]);
  });

  it('changed due date updates existing item', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create(), host as never);
    const before = (await listOf(router, 'u1')).items[0]!;
    await handle('todo.create.request')(create({ due: '2026-11-25T10:00:00Z', title: 'Prepare slides v2', assigneeId: 'u2' }), host as never);
    const { items } = await listOf(router, 'u1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: before.id, due: '2026-11-25T10:00:00.000Z', title: 'Prepare slides v2', assigneeId: 'u2', version: before.version + 1 });
    expect(host.published.at(-1)).toEqual({ name: 'todo.changed', payload: { itemId: before.id, kind: 'updated' } });
  });

  it('request after user completed it does not recreate', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create(), host as never);
    const item = (await listOf(router, 'u1')).items[0]!;
    await router.call('POST', `/items/${item.id}/done`, { ...as('u1'), body: { version: item.version, done: true } });
    await handle('todo.create.request')(create({ due: '2026-12-24T10:00:00Z' }), host as never);
    const { items } = await listOf(router, 'u1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ done: true, due: '2026-11-20T15:00:00.000Z' }); // untouched
  });

  it('request after user deleted it does not resurrect it', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create(), host as never);
    const item = (await listOf(router, 'u1')).items[0]!;
    expect((await router.call('DELETE', `/items/${item.id}`, { ...as('u1'), body: { version: item.version } })).status).toBe(200);
    await handle('todo.create.request')(create(), host as never);
    expect((await listOf(router, 'u1')).items).toHaveLength(0);
    // the tombstone also survives "clear done"
    expect(host.store.db.all('SELECT id FROM m_todo_items WHERE source_key = ?', ['cal:evt-1'])).toHaveLength(1);
  });

  it('an assigned request creates a private item for the assignee only', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create({ list: 'week', sourceKey: 'k', assigneeId: 'u2', due: null }), host as never);
    expect((await listOf(router, 'u2')).items).toHaveLength(1);
    expect((await listOf(router, 'u3')).items).toHaveLength(0);
    expect((await listOf(router, 'u2')).items[0]!.due).toBe('2026-11-22T23:59:00.000Z'); // implicit end of week (UTC)
  });
});

describe('todo.remove.request', () => {
  it('remove.request deletes open item only', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create({ sourceKey: 'open' }), host as never);
    await handle('todo.create.request')(create({ sourceKey: 'finished' }), host as never);
    const target = host.store.db.get<{ id: string; version: number }>('SELECT id, version FROM m_todo_items WHERE source_key = ?', ['finished'])!;
    await router.call('POST', `/items/${target.id}/done`, { ...as('u1'), body: { version: target.version, done: true } });
    await handle('todo.remove.request')({ sourceKey: 'open' }, host as never);
    await handle('todo.remove.request')({ sourceKey: 'finished' }, host as never);
    await handle('todo.remove.request')({ sourceKey: 'unknown' }, host as never);
    const rows = host.store.db.all<{ source_key: string; done: number }>('SELECT source_key, done FROM m_todo_items ORDER BY source_key');
    expect(rows.filter((r) => r.done === 1)).toHaveLength(1); // the completed one stays
    expect(rows).toHaveLength(1);
    expect(host.published.filter((p) => p.name === 'todo.changed' && (p.payload as { kind: string }).kind === 'deleted')).toHaveLength(1);
  });
});

describe('item.readLater', () => {
  it('creates a shared deadline item with the url once', async () => {
    const { host, router } = await setup();
    const payload = { title: 'Interesting article', url: 'https://example.org/a', source: 'rss' };
    await handle('item.readLater')(payload, host as never);
    await handle('item.readLater')(payload, host as never);
    const { items } = await listOf(router, 'u3');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ list: 'deadline', title: 'Interesting article', url: 'https://example.org/a', due: null });
  });

  it('ignores a url that is not http(s)', async () => {
    const { host, router } = await setup();
    await handle('item.readLater')({ title: 'x', url: 'javascript:alert(1)', source: 'rss' }, host as never);
    expect((await listOf(router, 'u1')).items).toHaveLength(0);
  });

  it('does not touch items made through the API', async () => {
    const { host, router } = await setup();
    await add(router, 'u1', { title: 'Mine' });
    await handle('item.readLater')({ title: 'x', url: 'https://example.org/b', source: 'rss' }, host as never);
    expect((await listOf(router, 'u1')).items).toHaveLength(2);
  });
});
