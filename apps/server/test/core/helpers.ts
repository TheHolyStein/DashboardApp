import { DashError } from '@dash/contract';
import type { AuthSeam } from '../../src/seams.ts';

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
