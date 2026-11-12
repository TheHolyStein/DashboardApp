import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

/**
 * Vitest config for a module package. Client tests (`*.client.test.ts`, `tests/client.test.ts`)
 * run in jsdom with the Svelte compiler; everything else runs in node.
 * Use as `export default moduleVitestConfig();` in the module's vitest.config.ts.
 */
export function moduleVitestConfig(): ViteUserConfig {
  return defineConfig({
    plugins: [svelte()],
    resolve: { conditions: ['browser'] },
    test: {
      passWithNoTests: true,
      // @testing-library/svelte-core ships `.svelte.js` files that must go through the Svelte compiler.
      server: { deps: { inline: [/@testing-library\/svelte/] } },
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: ['**/*.test.ts'],
            exclude: ['**/node_modules/**', '**/*.client.test.ts', '**/tests/client.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'client',
            environment: 'jsdom',
            include: ['**/*.client.test.ts', '**/tests/client.test.ts'],
            exclude: ['**/node_modules/**'],
          },
        },
      ],
    },
  });
}
