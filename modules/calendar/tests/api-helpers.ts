import { createMockHostWithSetup, createMockRouter, type MockHost, type MockRouter } from '@dash/module-kit/testing';
import server from '../server/index.js';
import type { OccurrenceDto } from '../server/dto.js';

export const NOW = new Date('2027-01-04T08:00:00.000Z'); // a Monday
export const USERS = [
  { id: 'u1', name: 'Dana', handle: 'dani', role: 'admin' as const, timeZone: 'Europe/Berlin' },
  { id: 'u2', name: 'Eli', handle: 'eli', role: 'member' as const, timeZone: 'Europe/Berlin' },
  { id: 'u3', name: 'Fay', handle: 'fay', role: 'member' as const, timeZone: 'America/New_York' },
];

export async function setup(): Promise<{ host: MockHost; router: MockRouter }> {
  const host = await createMockHostWithSetup(server, { now: NOW, prepare: (h) => h.setUsers(USERS) });
  return { host, router: createMockRouter(server, host) };
}

export const as = (userId: string, level: 'view' | 'edit' = 'edit') => ({ level, user: { id: userId, name: userId } });

/** The user's Personal calendar id (created on first access). */
export async function personal(router: MockRouter, userId: string): Promise<string> {
  const res = await router.call('GET', '/calendars', as(userId, 'view'));
  const cals = (res.body as { calendars: Array<{ id: string; name: string; ownerId: string }> }).calendars;
  const own = cals.find((c) => c.ownerId === userId && c.name === 'Personal');
  if (!own) throw new Error('no Personal calendar');
  return own.id;
}

export async function share(router: MockRouter, ownerId: string, calendarId: string, shares: Array<{ userId: string; level: 'view' | 'edit' }>) {
  const res = await router.call('PUT', `/calendars/${calendarId}/shares`, { ...as(ownerId), body: { shares } });
  if (res.status !== 200) throw new Error(`share failed ${res.status} ${JSON.stringify(res.body)}`);
}

export const base = {
  start: '2027-01-05T09:00:00',
  end: '2027-01-05T10:00:00',
  allDay: false,
  timeZone: 'Europe/Berlin',
};

export async function create(router: MockRouter, userId: string, body: Record<string, unknown>): Promise<{ uid: string; etag: string }> {
  const res = await router.call('POST', '/events', { ...as(userId), body: { title: 'Event', ...base, ...body } });
  if (res.status !== 200) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { uid: string; etag: string };
}

export async function events(
  router: MockRouter,
  userId: string,
  from = '2027-01-01T00:00:00Z',
  to = '2027-02-01T00:00:00Z',
  level: 'view' | 'edit' = 'edit',
): Promise<OccurrenceDto[]> {
  const res = await router.call('GET', '/events', { ...as(userId, level), query: { from, to } });
  if (res.status !== 200) throw new Error(`list failed ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { events: OccurrenceDto[] }).events;
}
