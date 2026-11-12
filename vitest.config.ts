import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'tools', include: ['tools/**/*.test.ts'] } },
      'apps/*',
      'packages/*',
      'modules/*',
      'themes/*',
    ],
  },
});
