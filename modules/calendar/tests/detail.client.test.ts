import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import { DashError, type DetailProps, type ModuleApi } from '@dash/contract';
import { identityT } from '@dash/ui';
import client from '../client/index.js';
import { settings as settingsSchema, type Settings } from '../manifest.js';
import type { OccurrenceDto } from '../server/dto.js';
import type { Snapshot } from '../server/reminders.js';

const CAL = { id: 'c1', name: 'Personal', color: '#3b82f6', kind: 'local', sourceUrl: null, ownerId: 'u1', access: 'owner', shares: null };

const occ = (over: Partial<OccurrenceDto> = {}): OccurrenceDto => ({
  uid: 'e1@x', calendarId: 'c1', etag: '"aaaa"', recurrenceId: null, title: 'Meeting', displayTitle: 'Meeting', description: '', location: '',
  start: '2027-01-15T10:00:00', end: '2027-01-15T11:00:00', startUtc: '2027-01-15T09:00:00.000Z', endUtc: '2027-01-15T10:00:00.000Z',
  allDay: false, timeZone: 'Europe/Berlin', rrule: null, seriesStart: '2027-01-15T10:00:00', seriesEnd: '2027-01-15T11:00:00',
  tags: [], mentions: [], color: '#3b82f6', editable: true, ...over,
});

type Fn = ReturnType<typeof vi.fn>;
function fakeApi(events: OccurrenceDto[], put?: Fn): { api: ModuleApi; get: Fn; put: Fn; post: Fn } {
  const get = vi.fn((path: string) => Promise.resolve(path === '/calendars' ? { calendars: [CAL] } : { events }));
  const p = put ?? vi.fn(() => Promise.resolve({ uid: 'e1@x', etag: '"bbbb"' }));
  const post = vi.fn(() => Promise.resolve({ uid: 'n@x', etag: '"cccc"' }));
  return { api: { get, put: p, post, patch: vi.fn(), delete: vi.fn(() => Promise.resolve(undefined)) } as unknown as ModuleApi, get, put: p, post };
}

const mounted: Array<() => void> = [];
beforeEach(() => vi.setSystemTime(new Date('2027-01-15T07:00:00Z')));
afterEach(() => {
  vi.useRealTimers();
  while (mounted.length > 0) mounted.pop()?.();
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
  flushSync();
}

async function detail(api: ModuleApi, over: Partial<DetailProps<Snapshot, Settings>> & { settingsOver?: Partial<Settings> } = {}): Promise<HTMLElement> {
  const { settingsOver, ...rest } = over;
  const target = document.body.appendChild(document.createElement('div'));
  const props: DetailProps<Snapshot, Settings> = {
    data: undefined, updatedAt: null, stale: false, settings: settingsSchema.parse(settingsOver ?? {}), instanceId: 'i1', level: 'edit', mode: 'day',
    api, t: identityT, locale: 'en-GB', timeZone: 'Europe/Berlin', isOwner: true, params: { date: '2027-01-15' }, close: () => undefined, ...rest,
  };
  const inst = mount(client.Detail as unknown as Component<Record<string, unknown>>, { target, props: props as unknown as Record<string, unknown> });
  mounted.push(() => void unmount(inst));
  await settle();
  return target;
}

function drag(el: Element, dy: number): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientY: 100 + dy }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientY: 100 + dy }));
}

const button = (el: HTMLElement, text: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('calendar detail', () => {
  test('month grid starts on configured week start', async () => {
    const { api } = fakeApi([occ()]);
    const sun = await detail(api, { settingsOver: { defaultView: 'month', weekStart: 'sun' } });
    const cells = sun.querySelectorAll('[data-testid="month"] [data-date]');
    expect(cells).toHaveLength(42);
    expect(cells[0]!.getAttribute('data-date')).toBe('2026-12-27');
    expect(sun.querySelector('[data-date="2027-01-15"]')?.textContent).toContain('Meeting');
    const mon = await detail(fakeApi([]).api, { settingsOver: { defaultView: 'month', weekStart: 'mon' } });
    expect(mon.querySelectorAll('[data-testid="month"] [data-date]')[0]!.getAttribute('data-date')).toBe('2026-12-28');
  });

  test('drag moves event by 30 min and sends PUT with etag', async () => {
    const { api, put } = fakeApi([occ()]);
    const el = await detail(api, { settingsOver: { defaultView: 'day' } });
    const block = el.querySelector('[data-uid="e1@x"]')!;
    drag(block, 24); // 24 px = 30 min at 0.8 px/min
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe('/events/e1%40x');
    expect(put.mock.calls[0]![1]).toMatchObject({ start: '2027-01-15T10:30:00', end: '2027-01-15T11:30:00', etag: '"aaaa"', scope: 'all', calendarId: 'c1', timeZone: 'Europe/Berlin' });
  });

  test('resize stretches the end only', async () => {
    const { api, put } = fakeApi([occ()]);
    const el = await detail(api, { settingsOver: { defaultView: 'day' } });
    drag(el.querySelector('[data-testid="resize"]')!, 12); // 15 min
    await settle();
    expect(put.mock.calls[0]![1]).toMatchObject({ start: '2027-01-15T10:00:00', end: '2027-01-15T11:15:00' });
  });

  test('recurring edit asks scope', async () => {
    const recurring = occ({ recurrenceId: '2027-01-15T09:00:00Z', rrule: 'FREQ=WEEKLY', seriesStart: '2027-01-01T10:00:00', seriesEnd: '2027-01-01T11:00:00' });
    const { api, put } = fakeApi([recurring]);
    const el = await detail(api, { settingsOver: { defaultView: 'day' } });
    drag(el.querySelector('[data-uid="e1@x"]')!, 48); // +1 h
    await settle();
    expect(el.querySelector('[data-testid="scope"]')).not.toBeNull();
    expect(put).not.toHaveBeenCalled();
    button(el, 'This event').click();
    await settle();
    expect(put.mock.calls[0]![1]).toMatchObject({ scope: 'this', occurrenceStart: '2027-01-15T09:00:00Z', start: '2027-01-15T11:00:00', rrule: null });
    expect(el.querySelector('[data-testid="scope"]')).toBeNull();
    // "all" moves the series from its first instance
    drag(el.querySelector('[data-uid="e1@x"]')!, 48);
    await settle();
    button(el, 'All events').click();
    await settle();
    expect(put.mock.calls[1]![1]).toMatchObject({ scope: 'all', start: '2027-01-01T11:00:00', end: '2027-01-01T12:00:00', rrule: 'FREQ=WEEKLY' });
  });

  test('409 shows conflict dialog', async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(new DashError('conflict', 'changed', { etag: '"newer"', event: { title: 'Elsewhere' } }))
      .mockResolvedValue({ uid: 'e1@x', etag: '"x"' });
    const { api } = fakeApi([occ()], put);
    const el = await detail(api, { settingsOver: { defaultView: 'day' } });
    drag(el.querySelector('[data-uid="e1@x"]')!, 24);
    await settle();
    expect(el.querySelector('[data-testid="conflict"]')?.textContent).toContain('changed elsewhere');
    button(el, 'Overwrite').click();
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![1]).toMatchObject({ etag: '"newer"', start: '2027-01-15T10:30:00' });
    expect(el.querySelector('[data-testid="conflict"]')).toBeNull();
  });

  test('command chips preview @dani and !remind 30m', async () => {
    const { api } = fakeApi([]);
    const el = await detail(api, { params: { mode: 'create', date: '2027-01-15' } });
    const input = el.querySelector('[data-testid="editor"] input') as HTMLInputElement;
    input.value = 'Dentist @dani !remind 30m';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    const chips = [...el.querySelectorAll('[data-testid="chips"] .chip')].map((c) => c.textContent);
    expect(chips).toEqual(['@dani', '!remind 30m']);
    button(el, 'Commands').click();
    flushSync();
    expect(el.querySelector('[data-testid="help"]')?.textContent).toContain('!countdown');
  });

  test('create sends POST with the viewer zone', async () => {
    const { api, post } = fakeApi([]);
    const el = await detail(api, { params: { mode: 'create', date: '2027-01-15' } });
    const input = el.querySelector('[data-testid="editor"] input') as HTMLInputElement;
    input.value = 'Lunch';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    button(el, 'Create').click();
    await settle();
    expect(post).toHaveBeenCalledWith('/events', expect.objectContaining({ title: 'Lunch', calendarId: 'c1', start: '2027-01-15T09:00:00', end: '2027-01-15T10:00:00', timeZone: 'Europe/Berlin', allDay: false }));
  });

  test('view user sees no editor', async () => {
    const { api, put } = fakeApi([occ({ editable: false, description: 'Room 4' })]);
    const el = await detail(api, { level: 'view', settingsOver: { defaultView: 'day' } });
    expect(el.querySelector('[data-edit]')).toBeNull();
    drag(el.querySelector('[data-uid="e1@x"]')!, 24);
    await settle();
    expect(put).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="editor"]')).toBeNull();
    expect(el.querySelector('[data-testid="event-card"]')?.textContent).toContain('Room 4');
    expect(el.querySelector('[data-edit]')).toBeNull();
  });
});
