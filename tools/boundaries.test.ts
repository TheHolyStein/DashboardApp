import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

test('a module importing another module is a lint error', async () => {
  const eslint = new ESLint();
  const [res] = await eslint.lintFiles(['tools/lint-fixtures/bad-module-import.ts']);
  expect(res!.messages.some((m) => m.ruleId === 'boundaries/element-types')).toBe(true);
});
