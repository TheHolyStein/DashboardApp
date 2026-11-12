// TEMPORARY: track B replaces this with the real AuthSeam. It exists only so main.ts compiles and runs.
import { DashError } from '@dash/contract';
import type { AuthSeam } from '../seams.js';

export function createAuthStub(): AuthSeam {
  return {
    plugin: async () => {},
    requireUser() {
      throw new DashError('unauthenticated', 'Authentication required');
    },
    levelFor: () => 'view',
    verifyAppPassword: () => null,
    onGrantsChanged: () => {},
    listUsers: () => [],
  };
}
