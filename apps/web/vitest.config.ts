import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // @testing-library/svelte ships `.svelte.js` files that must go through the Svelte compiler.
    server: { deps: { inline: [/@testing-library\/svelte/] } },
  },
});
