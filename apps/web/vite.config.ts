import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Every `import 'zod'` resolves to the shim, which configures zod (no eval probe) before any schema is built.
  resolve: {
    alias: [{ find: /^zod$/, replacement: fileURLToPath(new URL('./src/zod-shim.ts', import.meta.url)) }],
  },
  plugins: [
    svelte(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false, // registered from src/register-sw.ts (no inline script under the CSP)
      manifest: false, // public/manifest.webmanifest is hand-written
      injectManifest: {
        rollupFormat: 'iife', // /sw.js as a classic script (no module worker)
        // The shell: html, scripts, styles, manifest and app icons. Theme images and fonts are not precached;
        // the worker caches them at runtime (stale-while-revalidate).
        globPatterns: ['**/*.{js,css,html}', 'manifest.webmanifest', 'icons/*.png'],
        maximumFileSizeToCacheInBytes: 2_000_000,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  // Theme fonts and images are emitted as files, never data: URIs (the server CSP has no font-src data:).
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false, assetsInlineLimit: 0 },
});
