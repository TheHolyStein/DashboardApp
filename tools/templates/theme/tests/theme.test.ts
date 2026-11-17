// @vitest-environment jsdom
import { runThemeContractSuite } from '@dash/module-kit/theme';
import theme from '../theme.js';

runThemeContractSuite(theme, { themeDir: import.meta.dirname + '/..' });
