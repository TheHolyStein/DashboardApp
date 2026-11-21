import { beforeEach, describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import { applyMigrations, createMockHost, type MockHost } from '@dash/module-kit/testing';
import manifest from '../manifest.js';
import { migrations } from '../server/migrations.js';
import { completeItem, createItem, getItem, visibleTo, type NewItem } from '../server/items.js';

const NOW = new Date('2026-11-18T09:00:00Z'); // Wednesday
let host: MockHost;
beforeEach(() => {
  host = createMockHost(manifest, { now: NOW });
  applyMigrations(host, migrations);
});

const base = (over: Partial<NewItem> = {}): NewItem => ({ list: 'week', title: 'Task', ownerId: 'u1', ...over });
const open = (over: Partial<NewItem> = {}) => createItem(host.store.db, base(over), NOW, 'UTC');

describe('visibility', () => {
  it('private item invisible to others, visible to assignee', () => {
    const item = open({ visibility: 'private', assigneeId: 'u2' });
    expect(item.visibility).toBe('private');
    expect(visibleTo(item, 'u1')).toBe(true); // owner
    expect(visibleTo(item, 'u2')).toBe(true); // assignee
    expect(visibleTo(item, 'u3')).toBe(false);
  });

  it('shopping and chores default to shared, the other lists to private', () => {
    expect(open({ list: 'shopping' }).visibility).toBe('shared');
    expect(open({ list: 'chores' }).visibility).toBe('shared');
    expect(open({ list: 'week' }).visibility).toBe('private');
    expect(open({ list: 'month' }).visibility).toBe('private');
    expect(open({ list: 'deadline' }).visibility).toBe('private');
    expect(visibleTo(open({ list: 'shopping' }), 'u9')).toBe(true);
  });
});

describe('implicit due', () => {
  it('week item without due gets Sunday 23:59 local', () => {
    const item = createItem(host.store.db, base({ list: 'week' }), NOW, 'Europe/Berlin');
    expect(item.due).toBe('2026-11-22T22:59:00.000Z');
  });

  it('month item without due gets the last day of the month 23:59 local; explicit due is kept', () => {
    expect(createItem(host.store.db, base({ list: 'month' }), NOW, 'Europe/Berlin').due).toBe('2026-11-30T22:59:00.000Z');
    expect(open({ list: 'week', due: '2026-11-19T07:00:00Z' }).due).toBe('2026-11-19T07:00:00.000Z');
    expect(open({ list: 'deadline' }).due).toBeNull();
  });

  it('a date-only due means 23:59 local that day', () => {
    expect(createItem(host.store.db, base({ list: 'deadline', due: '2026-12-01' }), NOW, 'Europe/Berlin').due).toBe('2026-12-01T22:59:00.000Z');
  });
});

describe('validation', () => {
  it('rejects empty and over-long titles, bad icons and bad repeat', () => {
    expect(() => open({ title: '  ' })).toThrow(DashError);
    expect(() => open({ title: 'x'.repeat(201) })).toThrow(DashError);
    expect(() => open({ icon: 'two words' })).toThrow(DashError);
    expect(() => open({ icon: '🛒🛒' })).toThrow(DashError);
    expect(() => open({ list: 'week', repeatEvery: 1, repeatUnit: 'week' })).toThrow(DashError); // only chores repeat
    expect(open({ icon: '🛒' }).icon).toBe('🛒');
    expect(open({ icon: 'todo' }).icon).toBe('todo');
    expect(open({ title: 'x'.repeat(200) }).title).toHaveLength(200);
  });
});

describe('repeating chores', () => {
  const chore = (over: Partial<NewItem> = {}) =>
    open({
      list: 'chores',
      title: 'Bins',
      due: '2026-11-16T18:00:00Z',
      repeatEvery: 1,
      repeatUnit: 'week',
      rotation: ['a', 'b', 'c'],
      assigneeId: 'a',
      ...over,
    });

  it('completing weekly chore creates next with rotated assignee', () => {
    const item = chore();
    const { item: done, next } = completeItem(host.store.db, item.id, 'a', item.version, NOW, 'UTC');
    expect(done.done).toBe(true);
    expect(done.doneBy).toBe('a');
    expect(done.doneAt).toBe(NOW.toISOString());
    expect(done.version).toBe(item.version + 1);
    expect(next).not.toBeNull();
    expect(next!.due).toBe('2026-11-23T18:00:00.000Z');
    expect(next!.assigneeId).toBe('b');
    expect(next!.rotationIdx).toBe(1);
    expect(next!.done).toBe(false);
    expect(next!.title).toBe('Bins');
    expect(getItem(host.store.db, next!.id)?.version).toBe(1);
  });

  it('rotation wraps', () => {
    let item = chore();
    const seen: string[] = [item.assigneeId!];
    for (let i = 0; i < 3; i++) {
      const { next } = completeItem(host.store.db, item.id, 'a', item.version, NOW, 'UTC');
      item = next!;
      seen.push(item.assigneeId!);
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a']);
  });

  it('day and month steps keep the local time; month clamps the day', () => {
    const daily = chore({ repeatUnit: 'day', repeatEvery: 3, rotation: [] });
    expect(completeItem(host.store.db, daily.id, 'a', daily.version, NOW, 'UTC').next!.due).toBe('2026-11-19T18:00:00.000Z');
    const monthly = chore({ repeatUnit: 'month', repeatEvery: 1, rotation: [], due: '2026-01-31T10:00:00Z' });
    expect(completeItem(host.store.db, monthly.id, 'a', monthly.version, NOW, 'UTC').next!.due).toBe('2026-02-28T10:00:00.000Z');
  });

  it('a plain item spawns nothing, and completing twice does not spawn twice', () => {
    const plain = open();
    expect(completeItem(host.store.db, plain.id, 'u1', plain.version, NOW, 'UTC').next).toBeNull();
    const item = chore();
    const first = completeItem(host.store.db, item.id, 'a', item.version, NOW, 'UTC');
    const again = completeItem(host.store.db, item.id, 'a', first.item.version, NOW, 'UTC');
    expect(again.next).toBeNull();
    expect(host.store.db.all('SELECT id FROM m_todo_items WHERE title = ?', ['Bins'])).toHaveLength(2);
  });
});
