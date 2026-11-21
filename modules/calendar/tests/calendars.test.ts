import { describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import { createMockHostWithSetup, createMockRouter } from '@dash/module-kit/testing';
import server from '../server/index.js';
import {
  accessLevel,
  createCalendar,
  deleteCalendar,
  effectiveRight,
  ensurePersonal,
  share,
  visibleCalendars,
} from '../server/calendars.js';

const NOW = new Date('2027-01-05T10:00:00.000Z');

async function setup() {
  const host = await createMockHostWithSetup(server, { now: NOW });
  host.setUsers([
    { id: 'owner', name: 'Owner', handle: 'owner' },
    { id: 'friend', name: 'Friend', handle: 'friend' },
    { id: 'stranger', name: 'Stranger', handle: 'stranger' },
  ]);
  return { host, db: host.store.db, router: createMockRouter(server, host) };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DashError ? e.code : 'other';
  }
  return undefined;
}

describe('calendar access', () => {
  it('owner has owner access; stranger none', async () => {
    const { db } = await setup();
    const cal = createCalendar(db, 'owner', { name: 'Home', color: '#112233' }, { now: NOW });
    expect(accessLevel(db, cal.id, 'owner')).toBe('owner');
    expect(accessLevel(db, cal.id, 'stranger')).toBe('none');
    expect(accessLevel(db, 'no-such-calendar', 'owner')).toBe('none');
    expect(visibleCalendars(db, 'stranger')).toEqual([]);
    expect(visibleCalendars(db, 'owner').map((c) => c.id)).toEqual([cal.id]);
  });

  it('shared view user cannot write', async () => {
    const { db } = await setup();
    const cal = createCalendar(db, 'owner', { name: 'Home', color: '#112233' }, { now: NOW });
    share(db, cal.id, 'owner', 'friend', 'view');
    expect(accessLevel(db, cal.id, 'friend')).toBe('view');
    expect(effectiveRight('edit', accessLevel(db, cal.id, 'friend'))).toBe('view');
    expect(visibleCalendars(db, 'friend').map((c) => c.id)).toEqual([cal.id]);
    share(db, cal.id, 'owner', 'friend', 'edit');
    expect(effectiveRight('edit', accessLevel(db, cal.id, 'friend'))).toBe('edit');
    share(db, cal.id, 'owner', 'friend', 'none');
    expect(accessLevel(db, cal.id, 'friend')).toBe('none');
  });

  it('only owner may share or delete', async () => {
    const { db, router } = await setup();
    const cal = createCalendar(db, 'owner', { name: 'Home', color: '#112233' }, { now: NOW });
    share(db, cal.id, 'owner', 'friend', 'edit');
    expect(code(() => share(db, cal.id, 'friend', 'stranger', 'view'))).toBe('forbidden');
    expect(code(() => share(db, cal.id, 'stranger', 'stranger', 'view'))).toBe('not_found');
    expect(code(() => deleteCalendar(db, cal.id, 'friend'))).toBe('forbidden');
    expect(code(() => deleteCalendar(db, cal.id, 'stranger'))).toBe('not_found');
    expect(accessLevel(db, cal.id, 'owner')).toBe('owner');

    const put = await router.call('PUT', `/calendars/${cal.id}/shares`, {
      level: 'edit',
      user: { id: 'friend' },
      body: { shares: [] },
    });
    expect(put.status).toBe(403);
    const del = await router.call('DELETE', `/calendars/${cal.id}`, { level: 'edit', user: { id: 'friend' } });
    expect(del.status).toBe(403);

    const ok = await router.call('PUT', `/calendars/${cal.id}/shares`, {
      level: 'edit',
      user: { id: 'owner' },
      body: { shares: [{ userId: 'stranger', level: 'view' }] },
    });
    expect(ok.status).toBe(200);
    expect(accessLevel(db, cal.id, 'friend')).toBe('none');
    expect(accessLevel(db, cal.id, 'stranger')).toBe('view');
    expect((await router.call('DELETE', `/calendars/${cal.id}`, { level: 'edit', user: { id: 'owner' } })).status).toBe(204);
    expect(accessLevel(db, cal.id, 'stranger')).toBe('none');
  });

  it('module level view caps calendar edit share to read-only', async () => {
    const { db, router } = await setup();
    const cal = createCalendar(db, 'owner', { name: 'Home', color: '#112233' }, { now: NOW });
    share(db, cal.id, 'owner', 'friend', 'edit');
    const access = accessLevel(db, cal.id, 'friend');
    expect(effectiveRight('view', access)).toBe('view');
    expect(effectiveRight('edit', access)).toBe('edit');
    expect(effectiveRight('view', 'owner')).toBe('view');
    expect(effectiveRight('edit', 'owner')).toBe('edit');
    expect(effectiveRight('edit', 'none')).toBe('none');
    // At module level view the write routes are closed whatever the calendar says.
    const res = await router.call('PATCH', `/calendars/${cal.id}`, {
      level: 'view',
      user: { id: 'owner' },
      body: { name: 'x' },
    });
    expect(res.status).toBe(403);
  });

  it('first access creates Personal once', async () => {
    const { db, router } = await setup();
    const call = () => router.call('GET', '/calendars', { level: 'view', user: { id: 'owner' } });
    const first = await call();
    const second = await call();
    const list = (first.body as { calendars: Array<{ name: string; access: string; shares: unknown }> }).calendars;
    expect(list.map((c) => [c.name, c.access])).toEqual([['Personal', 'owner']]);
    expect((second.body as { calendars: unknown[] }).calendars).toHaveLength(1);
    // Direct calls and a user who deleted Personal: still once.
    ensurePersonal(db, 'owner', NOW);
    ensurePersonal(db, 'owner', NOW);
    const id = list.length === 1 ? visibleCalendars(db, 'owner')[0]!.id : '';
    deleteCalendar(db, id, 'owner');
    ensurePersonal(db, 'owner', NOW);
    expect(visibleCalendars(db, 'owner')).toEqual([]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM m_calendar_calendars WHERE name = 'Personal'")?.n).toBe(0);
    // Another user is independent.
    ensurePersonal(db, 'friend', NOW);
    expect(visibleCalendars(db, 'friend')).toHaveLength(1);
  });
});
