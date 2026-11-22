import { execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { generate, REPO_ROOT } from './gen-registry.ts';

const ID = 'zz-scaffold-test';
const THEME = 'zz-scaffold-theme';
const lockFile = path.join(REPO_ROOT, 'pnpm-lock.yaml');
const lockBefore = readFileSync(lockFile, 'utf8');
// Linking a scaffolded package changes the lockfile (restored in afterAll), so this install may not be frozen (on CI,
// CI=true, pnpm would otherwise default to --frozen-lockfile and refuse). It also needs registry metadata, which a
// frozen install never caches: prefer the cache, fetch only what is missing.
const LINK = 'pnpm install --prefer-offline --no-frozen-lockfile';
const run = (cmd: string): string => execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });

afterAll(() => {
  rmSync(path.join(REPO_ROOT, 'modules', ID), { recursive: true, force: true });
  rmSync(path.join(REPO_ROOT, 'themes', THEME), { recursive: true, force: true });
  writeFileSync(lockFile, lockBefore);
  try {
    run('pnpm install --offline --frozen-lockfile');
  } finally {
    generate(REPO_ROOT);
  }
}, 120_000);

test('new:module creates a module whose own tests pass', { timeout: 240_000 }, () => {
  run(`node tools/new-module.ts ${ID}`);
  expect(readFileSync(path.join(REPO_ROOT, 'modules', ID, 'manifest.ts'), 'utf8')).toContain(`id: '${ID}'`);
  run(LINK);
  const out = run(`pnpm --filter @dash/module-${ID} test`);
  expect(out).toMatch(/passed/);
  run(`pnpm --filter @dash/module-${ID} typecheck`);
  run(`pnpm exec eslint modules/${ID}`);
});

test('new:theme creates a theme whose own tests pass', { timeout: 240_000 }, () => {
  run(`node tools/new-theme.ts ${THEME}`);
  run(LINK);
  expect(run(`pnpm --filter @dash/theme-${THEME} test`)).toMatch(/passed/);
  run(`pnpm --filter @dash/theme-${THEME} typecheck`);
  run(`pnpm exec eslint themes/${THEME}`);
});

test('new:module rejects an invalid id with exit code 1', () => {
  expect(() => run("node tools/new-module.ts 'Foo!'")).toThrow(/invalid module id/);
});
