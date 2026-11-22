import { describe, expect, it } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import { settings, type ItemList, type Snapshot } from '../manifest.js';
import server from '../server/index.js';
import { add, as, listOf, setup, USERS } from './helpers.js';

const instance = (id: string, ownerId: string, over: Record<string, unknown> = {}): ModuleInstance => ({
  id,
  ownerId,
  pageId: 'p',
  settings: settings.parse(over),
});

describe('items routes', () => {
  it('stranger cannot patch private item (404)', async () => {
    const { router } = await setup();
    const item = await add(router, 'u1', { title: 'Secret', visibility: 'private' });
    for (const [method, path, body] of [
      ['PATCH', `/items/${item.id}`, { version: item.version, title: 'x' }],
      ['POST', `/items/${item.id}/done`, { version: item.version, done: true }],
      ['DELETE', `/items/${item.id}`, { version: item.version }],
    ] as const) {
      const res = await router.call(method, path, { ...as('u2'), body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await listOf(router, 'u2')).items).toHaveLength(0);
    const same = await router.call('PATCH', '/items/does-not-exist', { ...as('u2'), body: { version: 1, title: 'x' } });
    expect(same.status).toBe(404); // same answer as for an existing private item
    expect((await listOf(router, 'u1')).items[0]).toMatchObject({ title: 'Secret', version: item.version });
  });

  it('assignee may edit a private item, a shared item is open to every editor', async () => {
    const { router } = await setup();
    const mine = await add(router, 'u1', { title: 'Handed over', assigneeId: 'u2' });
    expect((await router.call('PATCH', `/items/${mine.id}`, { ...as('u2'), body: { version: mine.version, note: 'on it' } })).status).toBe(200);
    const shared = await add(router, 'u1', { list: 'shopping', title: 'Milk' });
    expect((await router.call('POST', `/items/${shared.id}/done`, { ...as('u3'), body: { version: shared.version, done: true } })).status).toBe(200);
  });

  it('clear-done removes only done items of that list visible to user', async () => {
    const { router } = await setup();
    const a = await add(router, 'u1', { list: 'shopping', title: 'Done shared' });
    const b = await add(router, 'u1', { list: 'shopping', title: 'Open shared' });
    const c = await add(router, 'u1', { list: 'week', title: 'Done other list' });
    const d = await add(router, 'u2', { list: 'shopping', title: 'Done private to u2', visibility: 'private' });
    for (const [user, item] of [['u1', a], ['u1', c], ['u2', d]] as const) {
      await router.call('POST', `/items/${item.id}/done`, { ...as(user), body: { version: item.version, done: true } });
    }
    const res = await router.call('POST', '/items/clear-done', { ...as('u1'), body: { list: 'shopping' } });
    expect(res.status).toBe(200);
    expect((res.body as ItemList).items.map((i) => i.title).sort()).toEqual(['Done other list', 'Open shared']);
    expect(b.id).toBeTruthy();
    // u2's private done item was not visible to u1: still there
    expect((await listOf(router, 'u2')).items.map((i) => i.title)).toContain('Done private to u2');
  });

  it('view level cannot write, and a viewer can list', async () => {
    const { router } = await setup();
    expect((await router.call('POST', '/items', { ...as('u1', 'view'), body: { list: 'week', title: 'x' } })).status).toBe(403);
    expect((await router.call('GET', '/items', as('u1', 'view'))).status).toBe(200);
  });

  it('rejects bad input with 422: empty title, unknown list, title over 200 characters, unknown assignee', async () => {
    const { router } = await setup();
    const post = (body: unknown) => router.call('POST', '/items', { ...as('u1'), body });
    expect((await post({ list: 'week', title: '' })).status).toBe(422);
    expect((await post({ list: 'nope', title: 'x' })).status).toBe(422);
    expect((await post({ list: 'week', title: 'x'.repeat(201) })).status).toBe(422);
    expect((await post({ list: 'week', title: 'x', assigneeId: 'ghost' })).status).toBe(422);
    expect((await post({ list: 'week', title: 'x', assigneeHandle: 'ghost' })).status).toBe(422);
    expect((await post({ list: 'chores', title: 'x', repeatEvery: 1, repeatUnit: 'week', rotation: ['u1', 'ghost'] })).status).toBe(422);
    expect((await post({ list: 'chores', title: 'x', repeatEvery: 1, repeatUnit: 'week', rotation: ['u1', 'u2'] })).status).toBe(200);
    const item = await add(router, 'u1', { list: 'chores', title: 'y' });
    expect((await router.call('PATCH', `/items/${item.id}`, { ...as('u1'), body: { version: item.version, repeatEvery: 1, repeatUnit: 'day', rotation: ['ghost'] } })).status).toBe(422);
  });

  it('undoing a done repeating chore through the API removes the spawned occurrence and reports it', async () => {
    const { host, router } = await setup();
    const chore = await add(router, 'u1', { list: 'chores', title: 'Bins', due: '2026-11-16T18:00:00Z', repeatEvery: 1, repeatUnit: 'week', rotation: ['u1', 'u2'] });
    const done = await router.call('POST', `/items/${chore.id}/done`, { ...as('u1'), body: { version: chore.version, done: true } });
    const afterDone = (done.body as ItemList).items;
    expect(afterDone.filter((i) => !i.done)).toHaveLength(1);
    const doneRow = afterDone.find((i) => i.id === chore.id)!;
    const undo = await router.call('POST', `/items/${chore.id}/done`, { ...as('u1'), body: { version: doneRow.version, done: false } });
    expect((undo.body as ItemList).items.map((i) => [i.id, i.done])).toEqual([[chore.id, false]]);
    expect(host.published.filter((p) => p.name === 'todo.changed').at(-1)).toEqual({ name: 'todo.changed', payload: { itemId: afterDone.find((i) => i.id !== chore.id)!.id, kind: 'deleted' } });
  });

  it('assigneeHandle resolves through the user list', async () => {
    const { router } = await setup();
    const item = await add(router, 'u1', { title: 'Buy milk', assigneeHandle: 'eli', list: 'shopping' });
    expect(item.assigneeId).toBe('u2');
  });

  it('the saved time zone of the user shapes the implicit due date and buckets; the client sends none', async () => {
    const { host, router } = await setup();
    const zoned = (timeZone: string) => USERS.map((u) => (u.id === 'u1' ? { ...u, timeZone } : u));
    host.setUsers(zoned('Europe/Berlin'));
    const item = await add(router, 'u1', { list: 'week', title: 'Plan' });
    expect(item.due).toBe('2026-11-22T22:59:00.000Z');
    expect(item.bucket).toBe('week');
    host.setUsers(zoned('Pacific/Auckland'));
    const late = await router.call('GET', '/items', as('u1', 'view'));
    // Sunday 22:59 UTC is already Monday in Auckland: the same instant falls into the next week there.
    expect((late.body as ItemList).items[0]!.bucket).toBe('month');
  });

  it('GET filters by list and show', async () => {
    const { router } = await setup();
    await add(router, 'u1', { list: 'shopping', title: 'Eggs' });
    await add(router, 'u1', { list: 'shopping', title: 'For Eli', assigneeId: 'u2' });
    await add(router, 'u1', { list: 'week', title: 'Week thing' });
    expect((await listOf(router, 'u1', { list: 'shopping' })).items).toHaveLength(2);
    expect((await listOf(router, 'u1', { list: 'shopping', show: 'mine' })).items.map((i) => i.title)).toEqual(['Eggs']);
    expect((await listOf(router, 'u1', { show: 'all' })).items).toHaveLength(3);
  });

  it('every answer carries epoch and a rising rev', async () => {
    const { router } = await setup();
    const first = await listOf(router, 'u1');
    await add(router, 'u1', {});
    const second = await listOf(router, 'u1');
    expect(second.epoch).toBe(first.epoch);
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.userId).toBe('u1');
  });

  it('lists are ordered overdue, today, week and done items last', async () => {
    const { router } = await setup();
    await add(router, 'u1', { title: 'Later', list: 'deadline', due: '2027-03-01' });
    await add(router, 'u1', { title: 'Overdue', list: 'deadline', due: '2026-11-10T10:00:00Z' });
    await add(router, 'u1', { title: 'Week', list: 'week' });
    await add(router, 'u1', { title: 'Today', list: 'deadline', due: '2026-11-18T20:00:00Z' });
    const done = await add(router, 'u1', { title: 'Done overdue', list: 'deadline', due: '2026-11-01' });
    await router.call('POST', `/items/${done.id}/done`, { ...as('u1'), body: { version: done.version, done: true } });
    expect((await listOf(router, 'u1')).items.map((i) => i.title)).toEqual(['Overdue', 'Today', 'Week', 'Later', 'Done overdue']);
  });
});

describe('PUT /order', () => {
  it('stores the caller order per list and returns it with the list', async () => {
    const { host, router } = await setup();
    const a = await add(router, 'u1', { list: 'shopping', title: 'A' });
    const b = await add(router, 'u1', { list: 'shopping', title: 'B' });
    const before = await listOf(router, 'u1');
    const res = await router.call('PUT', '/order', { ...as('u1'), body: { list: 'shopping', ids: [b.id, a.id] } });
    expect(res.status).toBe(200);
    expect((res.body as ItemList).order).toEqual({ shopping: [b.id, a.id] });
    expect((res.body as ItemList).rev).toBeGreaterThan(before.rev); // the answer is newer than what the client holds
    expect((await listOf(router, 'u1')).rev).toBe((res.body as ItemList).rev);
    expect((await listOf(router, 'u2')).order).toEqual({});
    expect(await host.store.get('order:u1:shopping')).toEqual([b.id, a.id]);
    expect((await router.call('PUT', '/order', { ...as('u1', 'view'), body: { list: 'shopping', ids: [] } })).status).toBe(403);
  });

  it('drops ids the caller cannot see', async () => {
    const { router } = await setup();
    const secret = await add(router, 'u2', { title: 'Secret' });
    const mine = await add(router, 'u1', { title: 'Mine' });
    const res = await router.call('PUT', '/order', { ...as('u1'), body: { list: 'week', ids: [secret.id, mine.id] } });
    expect((res.body as ItemList).order).toEqual({ week: [mine.id] });
  });
});

describe('snapshots, events and the day summary', () => {
  const I1 = '00000000-0000-7000-8000-0000000000a1';
  const I2 = '00000000-0000-7000-8000-0000000000a2';

  it('push one snapshot per instance with counts, items and the stamp', async () => {
    const { host, router } = await setup([instance(I1, 'u1', { show: 'all' }), instance(I2, 'u2', { lists: ['shopping'], show: 'all' })]);
    await add(router, 'u1', { list: 'deadline', title: 'Overdue', due: '2026-11-10T10:00:00Z' });
    await add(router, 'u1', { list: 'week', title: 'This week', assigneeId: 'u2' });
    await add(router, 'u1', { list: 'shopping', title: 'Milk', icon: '🥛' });
    const last = (id: string) => host.pushed.filter((p) => p.instanceId === id).at(-1)!.data as Snapshot;
    const s1 = last(I1);
    expect(s1.counts).toEqual({ overdue: 1, today: 0, week: 1, month: 0, later: 0, none: 1 });
    expect(s1.items.map((i) => i.title)).toEqual(['Overdue', 'This week', 'Milk']); // overdue → week → none
    expect(s1.items[1]).toMatchObject({ assigneeName: 'Eli', list: 'week', done: false });
    expect(s1.canEdit).toBe(true);
    const s2 = last(I2);
    expect(s2.items.map((i) => i.title)).toEqual(['Milk']); // list filter; the private items of u1 are not u2's
    expect(s2.rev).toBe(s1.rev);
    expect(s2.epoch).toBe(s1.epoch);
  });

  it('show mine hides items assigned to somebody else; hideDone false keeps done items, last', async () => {
    const { host, router } = await setup([instance(I1, 'u1', { hideDone: false })]);
    const a = await add(router, 'u1', { list: 'shopping', title: 'A' });
    await add(router, 'u1', { list: 'shopping', title: 'B', assigneeId: 'u2' });
    await add(router, 'u1', { list: 'shopping', title: 'C', due: '2026-12-31' });
    await router.call('POST', `/items/${a.id}/done`, { ...as('u1'), body: { version: a.version, done: true } });
    const snap = host.pushed.filter((p) => p.instanceId === I1).at(-1)!.data as Snapshot;
    expect(snap.items.map((i) => [i.title, i.done])).toEqual([['C', false], ['A', true]]);
    expect(snap.counts.none).toBe(0);
  });

  it('keeps at most 12 items', async () => {
    const { host, router } = await setup([instance(I1, 'u1')]);
    for (let i = 0; i < 15; i++) await add(router, 'u1', { title: `T${i}` });
    const snap = host.pushed.filter((p) => p.instanceId === I1).at(-1)!.data as Snapshot;
    expect(snap.items).toHaveLength(12);
    expect(snap.counts.week).toBe(15);
  });

  it('publishes todo.changed per change and todo.day.summary for affected users', async () => {
    const { host, router } = await setup();
    const item = await add(router, 'u1', { list: 'deadline', title: 'Pay rent', due: '2026-11-18T20:00:00Z', assigneeId: 'u2' });
    await add(router, 'u1', { list: 'deadline', title: 'Old', due: '2026-11-01T10:00:00Z', assigneeId: 'u2' });
    const events = (name: string) => host.published.filter((p) => p.name === name).map((p) => p.payload);
    expect(events('todo.changed')[0]).toEqual({ itemId: item.id, kind: 'created' });
    const summaries = events('todo.day.summary') as Array<{ userId: string; date: string; overdue: number; due: Array<{ id: string; title: string; list: string }> }>;
    const last = summaries.filter((s) => s.userId === 'u2').at(-1)!;
    expect(last).toEqual({ userId: 'u2', date: '2026-11-18', overdue: 1, due: [{ id: item.id, title: 'Pay rent', list: 'deadline' }] });
    expect(summaries.some((s) => s.userId === 'u3')).toBe(false); // nothing for an unaffected user
    await router.call('POST', `/items/${item.id}/done`, { ...as('u2'), body: { version: item.version, done: true } });
    expect(events('todo.changed').at(-1)).toEqual({ itemId: item.id, kind: 'done' });
    expect((events('todo.day.summary') as typeof summaries).at(-1)).toMatchObject({ userId: 'u2', due: [] });
  });

  it('rollover pushes fresh snapshots as time passes and publishes the new day', async () => {
    const { host, router } = await setup([instance(I1, 'u1')]);
    await add(router, 'u1', { list: 'deadline', title: 'Tomorrow', due: '2026-11-19T10:00:00Z' });
    const pushes = () => host.pushed.filter((p) => p.instanceId === I1).length;
    const before = host.pushed.filter((p) => p.instanceId === I1).at(-1)!.data as Snapshot;
    expect(before.counts.week).toBe(1);
    host.advance(24 * 3_600_000); // it is now the 19th, 09:00
    await server.jobs!['rollover']!({ host, instance: null, signal: new AbortController().signal });
    expect(pushes()).toBeGreaterThan(1);
    const after = host.pushed.filter((p) => p.instanceId === I1).at(-1)!.data as Snapshot;
    expect(after.counts).toMatchObject({ today: 1, week: 0 });
    expect(after.rev).toBe(before.rev); // time moved, no data change
    const n = pushes();
    await server.jobs!['rollover']!({ host, instance: null, signal: new AbortController().signal });
    expect(pushes()).toBe(n); // nothing changed, nothing pushed
  });

  it('rollover purges done items older than 30 days', async () => {
    const { host, router } = await setup();
    const a = await add(router, 'u1', { list: 'shopping', title: 'Old done' });
    await router.call('POST', `/items/${a.id}/done`, { ...as('u1'), body: { version: a.version, done: true } });
    host.advance(31 * 86_400_000);
    await server.jobs!['rollover']!({ host, instance: null, signal: new AbortController().signal });
    expect((await listOf(router, 'u1')).items).toHaveLength(0);
  });

  it('removing an instance forgets its last push', async () => {
    const { host, router } = await setup([instance(I1, 'u1')]);
    await add(router, 'u1', {});
    const n = host.pushed.length;
    await server.onInstanceChange!('removed', instance(I1, 'u1'), host);
    host.setInstances([instance(I1, 'u1')]);
    await add(router, 'u1', { title: 'again' });
    expect(host.pushed.length).toBeGreaterThan(n);
    expect(USERS.length).toBe(3);
  });
});

describe('GET /users', () => {
  it('lists the household for the assignee picker', async () => {
    const { router } = await setup();
    const res = await router.call('GET', '/users', as('u1', 'view'));
    expect(res.body).toEqual(USERS.map(({ id, name, handle }) => ({ id, name, handle })));
  });
});
