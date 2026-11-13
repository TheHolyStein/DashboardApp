/* eslint-disable @typescript-eslint/require-await */
import type { FastifyPluginAsync } from 'fastify';
import { DashError, type PermissionLevel } from '@dash/contract';
import type { AuthSeam, SessionUser } from '../../src/seams.ts';

/** Stub AuthSeam for tests: no users, every requireUser call is unauthenticated. */
export function stubAuth(overrides: Partial<AuthSeam> = {}): AuthSeam {
  return {
    plugin: async () => {},
    requireUser: () => {
      throw new DashError('unauthenticated', 'Authentication required');
    },
    levelFor: () => 'view',
    verifyAppPassword: () => null,
    onGrantsChanged: () => {},
    listUsers: () => [],
    ...overrides,
  };
}

export const TEST_USERS: Record<string, SessionUser> = {
  alice: { id: 'alice', name: 'Alice', handle: 'alice', role: 'member' },
  bob: { id: 'bob', name: 'Bob', handle: 'bob', role: 'member' },
};

/**
 * Header-driven AuthSeam for module tests. A request with `x-test-user: <id>` is that user; its session
 * csrf is `csrf-<id>`. `grants` maps `<userId>:<moduleId>` to a level (default `defaultLevel`, 'edit') and
 * can be mutated during a test. Like the real auth plugin it must not be encapsulated, hence the
 * skip-override symbol (what fastify-plugin sets).
 */
export function testAuth(
  opts: { grants?: Record<string, PermissionLevel>; defaultLevel?: PermissionLevel; appPassword?: string } = {},
): AuthSeam & { grants: Record<string, PermissionLevel> } {
  const grants = opts.grants ?? {};
  const plugin: FastifyPluginAsync = async (app) => {
    app.decorateRequest('user', null);
    app.decorateRequest('session', null);
    app.addHook('onRequest', async (req) => {
      const id = req.headers['x-test-user'];
      const u = typeof id === 'string' ? TEST_USERS[id] : undefined;
      if (u) {
        (req as unknown as { user: SessionUser }).user = u;
        req.session = { csrf: `csrf-${u.id}` };
      }
    });
  };
  (plugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
  return {
    grants,
    ...stubAuth({
      plugin,
      requireUser: (req) => {
        const u = (req as unknown as { user: SessionUser | null }).user;
        if (!u) throw new DashError('unauthenticated', 'Authentication required');
        return u;
      },
      levelFor: (userId, moduleId) => grants[`${userId}:${moduleId}`] ?? opts.defaultLevel ?? 'edit',
      verifyAppPassword: (header) =>
        opts.appPassword !== undefined && header === `Basic ${Buffer.from(opts.appPassword).toString('base64')}`
          ? (TEST_USERS['alice'] as SessionUser)
          : null,
      listUsers: () => Object.values(TEST_USERS),
    }),
  };
}
