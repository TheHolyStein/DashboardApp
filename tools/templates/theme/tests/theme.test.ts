import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { CONTRAST_PAIRS, REQUIRED_TOKENS, validateTheme } from '@dash/contract';
import theme from '../theme.js';

// The full theme contract suite arrives in a later task; this is the minimum every theme must meet.
const css = readFileSync(path.join(import.meta.dirname, '..', 'tokens.css'), 'utf8');

function block(mode: 'day' | 'night'): Record<string, string> {
  const m = new RegExp(`\\[data-theme="${theme.id}"\\]\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `tokens.css has a ${mode} block`).not.toBeNull();
  const out: Record<string, string> = {};
  for (const [, k, v] of (m?.[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[k ?? ''] = (v ?? '').trim();
  return out;
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}

test('theme manifest is valid', () => {
  expect(validateTheme(theme)).toEqual([]);
});

test.each(['day', 'night'] as const)('tokens.css defines every required token (%s)', (mode) => {
  const tokens = block(mode);
  expect(REQUIRED_TOKENS.filter((t) => !(t in tokens))).toEqual([]);
});

test.each(['day', 'night'] as const)('token colours meet the contrast pairs (%s)', (mode) => {
  const tokens = block(mode);
  for (const [fg, bg, min] of CONTRAST_PAIRS) {
    const a = luminance(tokens[fg] ?? '#000000');
    const b = luminance(tokens[bg] ?? '#000000');
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
  }
});
