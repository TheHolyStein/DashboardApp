import { test, expect } from 'vitest';
import { validateTheme, REQUIRED_TOKENS, type ThemeManifest, type ChartPalette } from '../src/index.js';

const palette = (n: number): ChartPalette => ({
  series: Array.from({ length: n }, (_, i) => `#${i}00000`),
  grid: '#cccccc', axis: '#999999', fill: 0.2, lineWidth: 2, glow: false,
});

const validTheme = (): ThemeManifest => ({
  id: 'paper', name: 'Paper', version: '1.0.0', description: '',
  css: ['tokens.css', 'theme.css'],
  backgrounds: [{ id: 'plain', name: 'Plain', component: () => Promise.resolve({ default: {} as never }), staticImage: 'plain.webp' }],
  clockFaces: [{ id: 'digital', name: 'Digital', component: () => Promise.resolve({ default: {} as never }) }],
  icons: {}, strings: {},
  chart: { day: palette(6), night: palette(6) },
  pane: { durationMs: 250, in: 'fade-in', out: 'fade-out' },
});

test('valid theme has no problems', () => expect(validateTheme(validTheme())).toEqual([]));
test('no backgrounds gives one problem', () =>
  expect(validateTheme({ ...validTheme(), backgrounds: [] })).toHaveLength(1));
test('tokens.css not first gives one problem', () =>
  expect(validateTheme({ ...validTheme(), css: ['theme.css', 'tokens.css'] })).toHaveLength(1));
test('5 chart series gives one problem', () =>
  expect(validateTheme({ ...validTheme(), chart: { day: palette(5), night: palette(6) } })).toHaveLength(1));
test('pane 900 ms gives one problem', () =>
  expect(validateTheme({ ...validTheme(), pane: { durationMs: 900, in: 'fade-in', out: 'fade-out' } })).toHaveLength(1));
test('REQUIRED_TOKENS has no duplicates', () =>
  expect(new Set(REQUIRED_TOKENS).size).toBe(REQUIRED_TOKENS.length));
