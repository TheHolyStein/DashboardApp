import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'tools', include: ['tools/**/*.test.ts'], exclude: ['tools/templates/**', '**/node_modules/**'], fileParallelism: false } },
      'apps/*',
      'packages/*',
      'modules/*',
      'themes/*',
    ],
  },
});
