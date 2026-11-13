import type { z } from 'zod';
import { HttpResponse } from 'msw';
import type { MeDto } from '@dash/contract';
import { session } from '../../src/lib/session.svelte.js';

export function makeMe(over: Partial<z.infer<typeof MeDto>> = {}): z.infer<typeof MeDto> {
  return {
    id: 'u1',
    name: 'Alice',
    handle: 'alice',
    role: 'admin',
    grants: {},
    csrf: 'csrf-token',
    prefs: { theme: 'default', modePolicy: 'system', locale: 'en', timeZone: 'UTC' },
    ...over,
  };
}

export function errorResponse(code: string, status: number, message = code, details?: unknown) {
  return HttpResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

/** Put the session in the signed-in state without any request (for rendering components under test). */
export function signIn(over: Partial<z.infer<typeof MeDto>> = {}): z.infer<typeof MeDto> {
  const me = makeMe(over);
  session.me = me;
  session.status = 'signedIn';
  return me;
}
