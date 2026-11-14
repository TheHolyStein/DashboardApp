// Production bundle: dist/main.js (server), dist/cli.js (admin CLI), code-split chunks for modules, dist/drizzle/.
// The @dash/* workspace packages are source-only TypeScript, so they and the generated module registry are
// bundled. Everything else listed in package.json "dependencies" stays external and is loaded from
// node_modules at runtime (better-sqlite3 and @node-rs/argon2 are native; fastify and the rest load fine
// unbundled and keep readable stack traces).
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';

const root = new URL('.', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@dash/'));

rmSync(new URL('dist', root), { recursive: true, force: true });

await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: { main: 'src/main.ts', cli: 'src/auth/cli.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  external,
  define: { __DASH_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});

cpSync(new URL('drizzle', root), new URL('dist/drizzle', root), { recursive: true });
