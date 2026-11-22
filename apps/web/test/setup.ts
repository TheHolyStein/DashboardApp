import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/svelte';
import { setupServer } from 'msw/node';
import { session } from '../src/lib/session.svelte.js';

/** Shared MSW server: register handlers per test with `server.use(...)`. Unhandled requests fail the test. */
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  session.clear();
  session.status = 'loading';
});
afterAll(() => server.close());
