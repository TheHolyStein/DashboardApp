import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { DashError } from '@dash/contract';
import type { AuthSeam, SessionUser } from '../seams.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function csrfOk(request: FastifyRequest): boolean {
  const want = request.session?.csrf;
  const got = request.headers['x-csrf'];
  if (typeof want !== 'string' || want === '' || typeof got !== 'string') return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validates with Zod; failure is a 422 `invalid` with the zod issues in `details`. */
export function parseWith<T extends z.ZodType>(schema: T, value: unknown, where = 'body'): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DashError('invalid', `Invalid ${where}`, { in: where, issues: parsed.error.issues });
  return parsed.data;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Registers a core route behind a session (401) and, for non-GET, the CSRF check (403). The handler's
 * return value is sent as JSON; `undefined` becomes 204.
 */
export function secured(
  app: FastifyInstance,
  auth: AuthSeam,
  method: Method,
  url: string,
  h: (user: SessionUser, req: FastifyRequest) => unknown,
): void {
  app.route({
    method,
    url,
    handler: async (req, reply) => {
      const user = auth.requireUser(req);
      requireCsrf(req);
      const result = await h(user, req);
      if (result === undefined) return reply.status(204).send();
      return reply.send(result);
    },
  });
}

/** Non-GET requests must carry `X-CSRF` equal to the session's token (403 otherwise). */
export function requireCsrf(request: FastifyRequest): void {
  if (!SAFE_METHODS.has(request.method) && !csrfOk(request)) {
    throw new DashError('forbidden', 'CSRF token missing or invalid');
  }
}
