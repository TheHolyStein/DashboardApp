import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

test('a module importing another module is a lint error', async () => {
  const eslint = new ESLint();
  const [res] = await eslint.lintFiles(['tools/lint-fixtures/bad-module-import.ts']);
  expect(res!.messages.some((m) => m.ruleId === 'boundaries/element-types')).toBe(true);
});

test('a theme runtime file importing the module kit is a lint error', async () => {
  const eslint = new ESLint();
  const [res] = await eslint.lintFiles(['tools/lint-fixtures/bad-theme-kit-import.ts']);
  expect(res!.messages.some((m) => m.ruleId === 'boundaries/element-types')).toBe(true);
});

test('a theme test file importing the module kit is allowed', async () => {
  const eslint = new ESLint();
  const [res] = await eslint.lintFiles(['tools/lint-fixtures/ok-theme-test-kit-import.ts']);
  expect(res!.messages.filter((m) => m.ruleId === 'boundaries/element-types')).toEqual([]);
});

test('a function type parameter name in a .svelte script is not flagged as unused', async () => {
  const eslint = new ESLint();
  const [res] = await eslint.lintFiles(['tools/lint-fixtures/svelte-type-signature.svelte']);
  expect(res!.messages.filter((m) => m.ruleId?.includes('no-unused-vars'))).toEqual([]);
});
