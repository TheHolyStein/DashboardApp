import { describe, expect, it } from 'vitest';
import { interpolate } from '../../src/lib/i18n.js';

describe('interpolate', () => {
  it('replaces own variables only, leaving prototype names as written', () => {
    expect(interpolate('{a} and {toString} and {b}', { a: 1 })).toBe('1 and {toString} and {b}');
    expect(interpolate('plain')).toBe('plain');
  });
});
