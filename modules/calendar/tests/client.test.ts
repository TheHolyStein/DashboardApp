import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { runClientContractSuite } from '@dash/module-kit/client';
import { loadFixture } from '@dash/module-kit/testing';
import type { TileProps } from '@dash/contract';
import { identityT } from '@dash/ui';
import client from '../client/index.js';
import { settings as settingsSchema, type Settings } from '../manifest.js';
import type { Snapshot } from '../server/reminders.js';

const moduleDir = import.meta.dirname + '/..';
runClientContractSuite(client, { moduleDir, tileFixture: 'tile', detailFixture: 'detail' });

const fixture = loadFixture<Snapshot>(moduleDir, 'tile');
const mounted: Array<() => void> = [];
beforeEach(() => vi.setSystemTime(new Date('2026-01-01T12:00:00Z')));
afterEach(() => {
  vi.useRealTimers();
  while (mounted.length > 0) mounted.pop()?.();
  document.body.innerHTML = '';
});

function tile(over: Partial<TileProps<Snapshot, Settings>> = {}): HTMLElement {
  const target = document.body.appendChild(document.createElement('div'));
  const props: TileProps<Snapshot, Settings> = {
    data: fixture, updatedAt: null, stale: false, settings: settingsSchema.parse({}), instanceId: 'i1', level: 'edit', size: { w: 4, h: 4 },
    mode: 'day', api: {} as never, t: identityT, locale: 'en-GB', timeZone: 'Europe/Berlin', isOwner: true, openDetail: () => undefined, ...over,
  };
  const inst = mount(client.Tile as unknown as Component<Record<string, unknown>>, { target, props: props as unknown as Record<string, unknown> });
  mounted.push(() => void unmount(inst));
  flushSync();
  return target;
}

describe('calendar tile', () => {
  test('groups by day with Today / Tomorrow labels', () => {
    const el = tile();
    const heads = [...el.querySelectorAll('h4.day')].map((h) => h.textContent?.trim());
    expect(heads).toEqual(['Today', 'Tomorrow']);
    const first = el.querySelectorAll('section')[0]!;
    // all-day first, then by time
    expect([...first.querySelectorAll('.title')].map((t) => t.textContent)).toEqual(['Holiday', 'Dentist']);
    expect(first.textContent).toContain('15:00');
    expect(el.textContent).toContain('@dani');
  });

  test('min size shows a single next event', () => {
    const el = tile({ size: { w: 2, h: 2 } });
    const next = el.querySelector('[data-testid="next-event"]');
    expect(next?.querySelector('.title')?.textContent).toBe('Dentist');
    expect(el.querySelectorAll('.title')).toHaveLength(1);
    expect(el.querySelector('[data-edit]')).toBeNull();
  });

  test('no events shows empty state', () => {
    const el = tile({ data: { ...fixture, today: [], next: [] } });
    expect(el.textContent).toContain('No upcoming events.');
  });

  test('"+" opens the detail in create mode', () => {
    const openDetail = vi.fn();
    const el = tile({ openDetail });
    (el.querySelector('[data-edit]') as HTMLButtonElement).click();
    expect(openDetail).toHaveBeenCalledWith({ mode: 'create' });
  });
});
