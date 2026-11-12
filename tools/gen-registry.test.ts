import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ID_RE as CONTRACT_ID_RE } from '../packages/contract/src/index.ts';
import { generate, ID_RE } from './gen-registry.ts';
import { newModule } from './new-module.ts';
import { newTheme } from './new-theme.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gen-registry-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function pkg(kind: 'modules' | 'themes', dir: string, name: string, extra: object = {}): void {
  mkdirSync(path.join(root, kind, dir), { recursive: true });
  writeFileSync(path.join(root, kind, dir, 'package.json'), JSON.stringify({ name, ...extra }));
}
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

test('ID_RE matches the contract', () => {
  expect(ID_RE.source).toBe(CONTRACT_ID_RE.source);
});

test('emits empty but valid registries when nothing exists', () => {
  expect(generate(root).exitCode).toBe(0);
  expect(read('apps/server/src/generated/modules.ts')).toContain('serverModules');
  expect(read('apps/web/src/generated/modules.ts')).toContain('clientModules');
  expect(read('apps/web/src/generated/themes.ts')).toContain('themes');
});

test('registries list modules and themes and skip _ folders', () => {
  pkg('modules', 'aaa', '@dash/module-aaa');
  pkg('modules', 'bbb', '@dash/module-bbb');
  pkg('modules', '_draft', '@dash/module-draft');
  pkg('themes', 'x', '@dash/theme-x', { dash: { name: 'The X' } });
  pkg('themes', 'plain', '@dash/theme-plain');
  expect(generate(root)).toMatchObject({ exitCode: 0 });

  const server = read('apps/server/src/generated/modules.ts');
  expect(server).toContain('modules/aaa/server/index.js');
  expect(server).toContain('modules/bbb/server/index.js');
  expect(server).not.toContain('draft');

  const web = read('apps/web/src/generated/modules.ts');
  expect(web).toContain('modules/aaa/manifest.js');
  expect(web).toContain('modules/bbb/client/index.js');
  expect(web).not.toContain('draft');

  const themes = read('apps/web/src/generated/themes.ts');
  expect(themes).toContain('themes/x/theme.js');
  expect(themes).toContain('"The X"');
  expect(themes).toContain('meta: { id: "plain", name: "plain" }');
});

test('duplicate module ids exit 1', () => {
  pkg('modules', 'aaa', '@dash/module-aaa');
  pkg('modules', 'bbb', '@dash/module-aaa');
  const res = generate(root);
  expect(res.exitCode).toBe(1);
  expect(res.messages.join('\n')).toContain('duplicate module id');
});

test('duplicate theme ids exit 1', () => {
  pkg('themes', 'a', '@dash/theme-x');
  pkg('themes', 'b', '@dash/theme-x');
  const res = generate(root);
  expect(res.exitCode).toBe(1);
  expect(res.messages.join('\n')).toContain('duplicate theme id');
});

test('folder name must equal the id', () => {
  pkg('modules', 'aaa', '@dash/module-zzz');
  const res = generate(root);
  expect(res.exitCode).toBe(1);
  expect(res.messages.join('\n')).toContain('folder name must equal the id');
});

test('new-module rejects invalid ids and writes nothing', () => {
  for (const bad of ['Foo!', 'a', '1abc', '']) {
    const res = newModule(root, bad);
    expect(res.exitCode, bad).toBe(1);
  }
  expect(newModule(root, 'Foo!').messages.join()).toContain('invalid module id');
});

test('new-module and new-theme refuse to overwrite and fill placeholders', () => {
  expect(newModule(root, 'my-foo').exitCode).toBe(0);
  const manifest = read('modules/my-foo/manifest.ts');
  expect(manifest).toContain("id: 'my-foo'");
  expect(manifest).toContain("name: 'My Foo'");
  expect(read('modules/my-foo/package.json')).toContain('"@dash/module-my-foo"');
  expect(read('apps/web/src/generated/modules.ts')).toContain('"my-foo"');
  expect(newModule(root, 'my-foo').exitCode).toBe(1);

  expect(newTheme(root, 'calm').exitCode).toBe(0);
  expect(read('themes/calm/theme.ts')).toContain("id: 'calm'");
  expect(read('apps/web/src/generated/themes.ts')).toContain('"Calm"');
  expect(newTheme(root, 'calm').exitCode).toBe(1);
  expect(newTheme(root, 'Bad!').exitCode).toBe(1);
});
