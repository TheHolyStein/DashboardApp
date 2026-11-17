import path from 'node:path';
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tseslint from 'typescript-eslint';

const tsFiles = ['**/*.ts'];
const svelteFiles = ['**/*.svelte', '**/*.svelte.ts'];

// Import-boundary element types. First match wins, so specific packages precede the generic `ui` glob.
const elements = [
  { type: 'app', pattern: 'apps/*', mode: 'folder', capture: ['name'] },
  { type: 'contract', pattern: 'packages/contract', mode: 'folder' },
  { type: 'module-kit', pattern: 'packages/module-kit', mode: 'folder' },
  { type: 'ui', pattern: 'packages/*', mode: 'folder' },
  { type: 'module', pattern: 'modules/*', mode: 'folder', capture: ['id'] },
  // Test fixture standing in for a file of module "aaa" (see tools/boundaries.test.ts).
  {
    type: 'module',
    pattern: 'tools/lint-fixtures/bad-module-import.ts',
    mode: 'full',
    capture: [],
  },
  // Theme test files may use the kit's theme suite (`@dash/module-kit/theme`); theme runtime files may not.
  // Listed before `theme` because the first match wins.
  { type: 'theme-test', pattern: 'themes/*/tests', mode: 'folder', capture: ['id'] },
  { type: 'theme-test', pattern: 'themes/*/vitest.config.ts', mode: 'full', capture: ['id'] },
  // Test fixtures standing in for a theme runtime file and a theme test file of theme "aaa".
  { type: 'theme', pattern: 'tools/lint-fixtures/bad-theme-kit-import.ts', mode: 'full', capture: [] },
  { type: 'theme-test', pattern: 'tools/lint-fixtures/ok-theme-test-kit-import.ts', mode: 'full', capture: [] },
  { type: 'theme', pattern: 'themes/*', mode: 'folder', capture: ['id'] },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.data/**',
      '**/.svelte-kit/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '.superpowers/**',
      '.claude/**',
      '**/generated/**',
      'tools/templates/**',
    ],
  },
  js.configs.recommended,
  {
    files: tsFiles,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['tools/lint-fixtures/*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.svelte'] },
      globals: { ...globals.browser },
    },
    // The base rule reports parameter names inside function type signatures; the typescript-eslint rule knows types.
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { 'no-unused-vars': 'off', '@typescript-eslint/no-unused-vars': 'error' },
  },
  {
    files: [...tsFiles, ...svelteFiles],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': elements,
      'boundaries/ignore': ['**/*.test.ts'],
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
        [path.resolve(import.meta.dirname, 'tools/fixture-resolver.cjs')]: {},
      },
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'app', allow: ['app', 'contract', 'module-kit', 'ui', 'module', 'theme'] },
            { from: 'contract', allow: ['contract'] },
            { from: 'module-kit', allow: ['module-kit', 'contract'] },
            { from: 'ui', allow: ['ui', 'contract'] },
            {
              from: 'module',
              allow: [
                'contract',
                'module-kit',
                'ui',
                ['module', { id: '${from.id}' }],
              ],
            },
            {
              from: 'theme',
              allow: ['contract', 'ui', ['theme', { id: '${from.id}' }]],
            },
            {
              from: 'theme-test',
              allow: ['contract', 'ui', 'module-kit', ['theme', { id: '${from.id}' }]],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['modules/*/server/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'use host.now()',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'use host.now()',
        },
      ],
    },
  },
);
