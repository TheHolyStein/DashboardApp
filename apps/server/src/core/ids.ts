import { randomBytes } from 'node:crypto';

/** UUID v7 (48-bit ms timestamp from the injected clock, 74 random bits). No dependency. */
export function uuidv7(now: Date): string {
  const b = randomBytes(16);
  const ms = BigInt(now.getTime());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
