import { describe, expect, it } from 'vitest';
import { byteCapacity, encodeQr, formatBits, qrPath, reedSolomonRemainder, versionBits } from '../../src/lib/qr.js';

const bits = (n: number, len: number): string => n.toString(2).padStart(len, '0');

describe('qr encoder', () => {
  it('Reed-Solomon matches the published "HELLO WORLD" 1-Q vector', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
    expect(reedSolomonRemainder(data, 13)).toEqual([168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]);
  });

  it('format bits for level M match the ISO table', () => {
    const table = [
      '101010000010010',
      '101000100100101',
      '101111001111100',
      '101101101001011',
      '100010111111001',
      '100000011001110',
      '100111110010111',
      '100101010100000',
    ];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((m) => bits(formatBits(m), 15))).toEqual(table);
  });

  it('version information matches the ISO table', () => {
    expect(bits(versionBits(7), 18)).toBe('000111110010010100');
    expect(bits(versionBits(8), 18)).toBe('001000010110111100');
    expect(bits(versionBits(10), 18)).toBe('001010010011010011');
  });

  it('capacities at level M for versions 1-10', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(byteCapacity)).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  });

  it('picks the smallest version and has the fixed patterns in place', () => {
    for (const [len, side] of [[14, 21], [15, 25], [62, 33], [213, 57]] as const) {
      const m = encodeQr('a'.repeat(len));
      expect(m.length).toBe(side);
      expect(m.every((r) => r.length === side)).toBe(true);
      // finder patterns: dark ring, light ring, dark 3x3 core, at three corners
      for (const [x0, y0] of [[0, 0], [side - 7, 0], [0, side - 7]] as const) {
        expect(m[y0]![x0]).toBe(true);
        expect(m[y0 + 1]![x0 + 1]).toBe(false);
        expect(m[y0 + 3]![x0 + 3]).toBe(true);
        expect(m[y0 + 6]![x0 + 6]).toBe(true);
      }
      // timing pattern and the always-dark module
      expect(m[6]![8]).toBe(true);
      expect(m[6]![9]).toBe(false);
      expect(m[side - 8]![8]).toBe(true);
    }
  });

  it('the format information in the symbol is a valid level-M word and both copies agree', () => {
    const m = encodeQr('otpauth://totp/Dash:alice?secret=JBSWY3DPEHPK3PXP&issuer=Dash');
    const n = m.length;
    const b = (x: number, y: number): number => (m[y]![x] ? 1 : 0);
    let first = 0;
    const pos1: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    pos1.forEach(([x, y], i) => (first |= b(x, y) << i));
    let second = 0;
    for (let i = 0; i < 8; i++) second |= b(n - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) second |= b(8, n - 15 + i) << i;
    expect(second).toBe(first);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(formatBits)).toContain(first);
  });

  it('is deterministic, handles UTF-8, and rejects payloads above 213 bytes', () => {
    expect(encodeQr('hello')).toEqual(encodeQr('hello'));
    expect(encodeQr('Grüße ✓').length).toBeGreaterThanOrEqual(21);
    expect(() => encodeQr('x'.repeat(214))).toThrow(RangeError);
    expect(() => encodeQr('x'.repeat(213))).not.toThrow();
  });

  it('qrPath emits one square per dark module with a quiet zone', () => {
    const m = encodeQr('a');
    const dark = m.flat().filter(Boolean).length;
    const { d, side } = qrPath(m);
    expect(side).toBe(m.length + 8);
    expect(d.split('M').length - 1).toBe(dark);
    expect(d.startsWith('M4 4h1v1h-1z')).toBe(true); // top-left finder corner
  });
});
