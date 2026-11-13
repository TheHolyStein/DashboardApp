import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { DashError, MeDto } from '@dash/contract';
import { z } from 'zod';
import { api, moduleApi } from '../../src/lib/api.js';
import { session } from '../../src/lib/session.svelte.js';
import { server } from '../setup.js';
import { errorResponse, makeMe, signIn } from './helpers.js';

describe('api', () => {
  it('api adds X-CSRF on non-GET', async () => {
    signIn({ csrf: 'tok-123' });
    const seen: Record<string, string | null> = {};
    server.use(
      http.get('/api/ping', ({ request }) => {
        seen.get = request.headers.get('x-csrf');
        return HttpResponse.json({ ok: true });
      }),
      http.post('/api/ping', async ({ request }) => {
        seen.post = request.headers.get('x-csrf');
        seen.ct = request.headers.get('content-type');
        seen.body = JSON.stringify(await request.json());
        return HttpResponse.json({ ok: true });
      }),
      http.delete('/api/ping', ({ request }) => {
        seen.del = request.headers.get('x-csrf');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await api.get('/ping');
    await api.post('/ping', { a: 1 });
    await api.delete('/ping');
    expect(seen.get).toBeNull();
    expect(seen.post).toBe('tok-123');
    expect(seen.del).toBe('tok-123');
    expect(seen.ct).toContain('application/json');
    expect(seen.body).toBe('{"a":1}');
  });

  it('ErrorDto becomes DashError with code', async () => {
    server.use(http.get('/api/x', () => errorResponse('conflict', 409, 'taken', { field: 'name' })));
    const err = await api.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DashError);
    expect(err).toMatchObject({ code: 'conflict', message: 'taken', details: { field: 'name' } });
  });

  it('non-JSON error body becomes internal', async () => {
    server.use(http.get('/api/x', () => new HttpResponse('<html>oops</html>', { status: 500 })));
    await expect(api.get('/x')).rejects.toMatchObject({ code: 'internal' });
  });

  it('204 resolves to undefined', async () => {
    server.use(http.delete('/api/x', () => new HttpResponse(null, { status: 204 })));
    await expect(api.delete('/x')).resolves.toBeUndefined();
  });

  it('schema mismatch throws DashError internal', async () => {
    server.use(http.get('/api/x', () => HttpResponse.json({ nope: 1 })));
    const err = await api.get('/x', z.object({ a: z.string() })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DashError);
    expect(err).toMatchObject({ code: 'internal' });
  });

  it('network failure throws DashError upstream', async () => {
    server.use(http.get('/api/x', () => HttpResponse.error()));
    await expect(api.get('/x')).rejects.toMatchObject({ code: 'upstream' });
  });

  it('moduleApi encodes the query string under /api/m/<id>/', async () => {
    let url = '';
    server.use(
      http.get('/api/m/x/a', ({ request }) => {
        url = new URL(request.url).pathname + new URL(request.url).search;
        return HttpResponse.json({ ok: true });
      }),
    );
    await moduleApi('x').get('/a', { q: 1 });
    expect(url).toBe('/api/m/x/a?q=1');
  });

  it('401 anywhere returns to login', async () => {
    server.use(http.get('/api/me', () => HttpResponse.json(makeMe())), http.get('/api/pages', () => errorResponse('unauthenticated', 401)));
    await session.refresh();
    expect(session.status).toBe('signedIn');
    await expect(api.get('/pages')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(session.me).toBeNull();
    expect(session.status).toBe('signedOut');
  });

  it('refresh() with 401 ends signedOut without throwing', async () => {
    server.use(http.get('/api/me', () => errorResponse('unauthenticated', 401)));
    await expect(session.refresh()).resolves.toBeUndefined();
    expect(session.status).toBe('signedOut');
    expect(MeDto).toBeDefined();
  });
});
