import { describe, expect, it } from 'vitest';
import { as, base, create, events, personal, setup } from './api-helpers.js';

describe('event conflicts', () => {
  it('PUT with stale etag → 409 and stored event unchanged', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, title: 'Original' });
    const first = await router.call('PUT', `/events/${ev.uid}`, { ...as('u1'), body: { ...base, calendarId: cal, etag: ev.etag, title: 'Second' } });
    expect(first.status).toBe(200);
    const stale = await router.call('PUT', `/events/${ev.uid}`, { ...as('u1'), body: { ...base, calendarId: cal, etag: ev.etag, title: 'Lost' } });
    expect(stale.status).toBe(409);
    const err = (stale.body as { error: { code: string; details: { etag: string; event: { title: string } } } }).error;
    expect(err.code).toBe('conflict');
    expect(err.details.event.title).toBe('Second');
    expect(err.details.etag).toBe((first.body as { etag: string }).etag);
    expect((await events(router, 'u1')).map((e) => e.title)).toEqual(['Second']);
  });

  it('two concurrent PUTs with the same etag: exactly one succeeds', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, title: 'Original' });
    const put = (title: string) =>
      router.call('PUT', `/events/${ev.uid}`, { ...as('u1'), body: { ...base, calendarId: cal, etag: ev.etag, title } });
    const results = await Promise.all([put('A'), put('B')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? 'A' : 'B';
    expect((await events(router, 'u1')).map((e) => e.title)).toEqual([winner]);
  });

  it('DELETE with stale etag → 409', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal });
    await router.call('PUT', `/events/${ev.uid}`, { ...as('u1'), body: { ...base, calendarId: cal, etag: ev.etag, title: 'Moved' } });
    const res = await router.call('DELETE', `/events/${ev.uid}`, { ...as('u1'), query: { calendarId: cal, etag: ev.etag } });
    expect(res.status).toBe(409);
    expect(await events(router, 'u1')).toHaveLength(1);
  });
});
