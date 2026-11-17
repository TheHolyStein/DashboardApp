// On-demand build check (a real Vite production build, ~1 s): `pnpm --filter @dash/web test:theme-build`
// i.e. `DASH_BUILD_TESTS=1 pnpm --filter @dash/web exec vitest run test/theme/css-pipeline.test.ts`.
// Skipped in `pnpm check` because it temporarily creates a folder under themes/ in the shared working tree.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(import.meta.dirname, '../..');
const themesDir = path.resolve(webRoot, '../../themes');

describe.skipIf(!process.env.DASH_BUILD_TESTS)('theme stylesheet pipeline (production build)', () => {
  it('bundles @import, rewrites url() to emitted hashed assets', { timeout: 60_000 }, async () => {
    const id = `zzprobe${process.pid}`;
    const themeDir = path.join(themesDir, id);
    const entryDir = path.join(webRoot, `.probe-${process.pid}`);
    const outDir = mkdtempSync(path.join(tmpdir(), 'dash-css-'));
    try {
      mkdirSync(path.join(themeDir, 'fonts'), { recursive: true });
      mkdirSync(path.join(themeDir, 'background'));
      writeFileSync(path.join(themeDir, 'tokens.css'), ':root[data-theme="zz"][data-mode="day"] { --db-bg: #fff; }\n');
      writeFileSync(path.join(themeDir, 'more.css'), '.more { margin: 0px; }\n');
      writeFileSync(
        path.join(themeDir, 'extra.css'),
        "@import './more.css';\n@font-face { font-family: P; src: url('./fonts/probe.woff2') format('woff2'); }\n.bg { background-image: url('./background/probe.webp'); }\n",
      );
      writeFileSync(path.join(themeDir, 'fonts/probe.woff2'), Buffer.alloc(9000, 1));
      writeFileSync(path.join(themeDir, 'background/probe.webp'), Buffer.alloc(9000, 2));
      mkdirSync(entryDir);
      writeFileSync(path.join(entryDir, 'index.html'), '<!doctype html><script type="module" src="./main.ts"></script>');
      writeFileSync(path.join(entryDir, 'main.ts'), "import { loadThemeStylesheet } from '../src/theme/css-loader.ts';\nconsole.log(loadThemeStylesheet);\n");

      await build({
        root: webRoot,
        configFile: false,
        logLevel: 'silent',
        plugins: [svelte()],
        build: { outDir, emptyOutDir: true, assetsDir: 'assets', rollupOptions: { input: path.join(entryDir, 'index.html') } },
      });

      const assets = path.join(outDir, 'assets');
      const cssFiles = readdirSync(assets).filter((f) => f.endsWith('.css'));
      const extra = cssFiles.map((f) => readFileSync(path.join(assets, f), 'utf8')).find((c) => c.includes('@font-face'));
      expect(extra, 'extra.css emitted as its own stylesheet').toBeDefined();
      expect(extra).not.toContain('@import');
      expect(extra).toContain('.more{margin:0}'); // @import inlined and minified
      const urls = [...(extra ?? '').matchAll(/url\(([^)]+)\)/g)].map((m) => m[1] ?? '');
      expect(urls).toHaveLength(2);
      for (const u of urls) {
        expect(u).toMatch(/^\/assets\/probe-[\w-]+\.(woff2|webp)$/);
        expect(existsSync(path.join(outDir, u)), `${u} exists in the build output`).toBe(true);
      }
    } finally {
      rmSync(themeDir, { recursive: true, force: true });
      rmSync(entryDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
