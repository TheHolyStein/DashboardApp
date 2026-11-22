// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { ICON_KEYS } from '@dash/contract';
import { runThemeContractSuite } from '@dash/module-kit/theme';
import theme from '../theme.js';

runThemeContractSuite(theme, { themeDir: import.meta.dirname + '/..' });

test('default theme draws every icon key, each different', () => {
  expect(ICON_KEYS.filter((k) => !theme.icons[k])).toEqual([]);
  expect(new Set(ICON_KEYS.map((k) => theme.icons[k])).size).toBe(ICON_KEYS.length);
});
