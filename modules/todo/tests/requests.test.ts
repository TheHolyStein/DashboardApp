import { describe, expect, it } from 'vitest';
import type { EventPayload } from '@dash/contract';
import server from '../server/index.js';
import { add, as, listOf, setup, USERS } from './helpers.js';

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

  it('an update with no due keeps the existing due on a week list, however much time passes', async () => {
    const { host, router } = await setup();
    const req = create({ list: 'week', due: null, ownerId: 'u1', title: 'Weekly thing' });
    await handle('todo.create.request')(req, host as never);
    const before = (await listOf(router, 'u1')).items[0]!;
    host.advance(10 * 86_400_000);
    await handle('todo.create.request')({ ...req, title: 'Weekly thing 2' }, host as never);
    const after = (await listOf(router, 'u1')).items[0]!;
    expect(after.due).toBe(before.due);
    expect(after.version).toBe(before.version + 1); // only the title changed
    await handle('todo.create.request')({ ...req, title: 'Weekly thing 2' }, host as never);
    expect((await listOf(router, 'u1')).items[0]!.version).toBe(after.version); // identical re-emit: nothing
  });

  it('a re-emitted request does not overwrite a manual edit, but a changed request field applies', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create({ ownerId: 'u1' }), host as never);
    const item = (await listOf(router, 'u1')).items[0]!;
    await router.call('PATCH', `/items/${item.id}`, { ...as('u1'), body: { version: item.version, title: 'My own title', assigneeId: 'u2' } });
    await handle('todo.create.request')(create({ ownerId: 'u1' }), host as never);
    expect((await listOf(router, 'u1')).items[0]).toMatchObject({ title: 'My own title', assigneeId: 'u2' });
    await handle('todo.create.request')(create({ ownerId: 'u1', due: '2026-11-25T10:00:00Z' }), host as never);
    expect((await listOf(router, 'u1')).items[0]).toMatchObject({ title: 'My own title', assigneeId: 'u2', due: '2026-11-25T10:00:00.000Z' });
  });

  it('owners: ownerId makes an item of that user, no owner a shared household item; keys are per owner', async () => {
    const { host, router } = await setup();
    await handle('todo.create.request')(create({ sourceKey: 'k', ownerId: 'u1' }), host as never);
    await handle('todo.create.request')(create({ sourceKey: 'k', ownerId: 'u2' }), host as never);
    await handle('todo.create.request')(create({ sourceKey: 'k', ownerId: null }), host as never);
    await handle('todo.create.request')(create({ sourceKey: 'k2', ownerId: 'u1', list: 'shopping' }), host as never);
    await handle('todo.create.request')(create({ sourceKey: 'k3', ownerId: 'u1', visibility: 'shared' }), host as never);
    const rows = host.store.db.all<{ source_key: string; owner_id: string; visibility: string }>('SELECT source_key, owner_id, visibility FROM m_todo_items');
    expect(rows.filter((r) => r.source_key === 'k').map((r) => r.owner_id).sort()).toEqual(['system', 'u1', 'u2']);
    const vis = (k: string, o: string) => rows.find((r) => r.source_key === k && r.owner_id === o)?.visibility;
    expect(vis('k', 'u1')).toBe('private'); // deadline default
    expect(vis('k', 'system')).toBe('shared');
    expect(vis('k2', 'u1')).toBe('shared'); // shopping default
    expect(vis('k3', 'u1')).toBe('shared');
    expect((await listOf(router, 'u3')).items.map((i) => i.ownerId).sort()).toEqual(['system', 'u1', 'u1']); // the shared ones
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
    await handle('todo.create.request')(create({ list: 'week', sourceKey: 'k', assigneeId: 'u2', ownerId: 'u2', due: null }), host as never);
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
  it('creates a private deadline item with the url, once, for the publishing user', async () => {
    const { host, router } = await setup();
    const payload = { title: 'Interesting article', url: 'https://example.org/a', source: 'rss', userId: 'u2' };
    await handle('item.readLater')(payload, host as never);
    await handle('item.readLater')(payload, host as never);
    const { items } = await listOf(router, 'u2');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ list: 'deadline', title: 'Interesting article', url: 'https://example.org/a', due: null, visibility: 'private', ownerId: 'u2' });
    expect((await listOf(router, 'u1')).items).toHaveLength(0);
  });

  it('without a user it makes one private item per admin', async () => {
    const { host, router } = await setup();
    host.setUsers(USERS.map((u) => ({ ...u, role: u.id === 'u3' ? ('member' as const) : ('admin' as const) })));
    const payload = { title: 'Article', url: 'https://example.org/c', source: 'rss', userId: null };
    await handle('item.readLater')(payload, host as never);
    await handle('item.readLater')(payload, host as never);
    expect((await listOf(router, 'u1')).items).toHaveLength(1);
    expect((await listOf(router, 'u2')).items).toHaveLength(1);
    expect((await listOf(router, 'u3')).items).toHaveLength(0);
    expect(host.store.db.all('SELECT id FROM m_todo_items')).toHaveLength(2);
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
