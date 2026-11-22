// Generates the app icons (flat accent square with four tiles). Run: node apps/web/scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';

const out = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

const BG = [0x1f, 0x5f, 0xd1];
const FG = [0xff, 0xff, 0xff];

/** `inset`: fraction of the side kept clear around the tiles (larger for maskable icons). `round`: rounded corners. */
function png(size, inset, round) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const pad = size * inset;
  const cell = (size - 2 * pad) / 2;
  const gap = cell * 0.14;
  const r = size * 0.18;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let alpha = 255;
      if (round) {
        const dx = Math.max(r - x - 0.5, 0, x + 0.5 - (size - r));
        const dy = Math.max(r - y - 0.5, 0, y + 0.5 - (size - r));
        if (dx * dx + dy * dy > r * r) alpha = 0;
      }
      const inGrid = x >= pad && x < size - pad && y >= pad && y < size - pad;
      const lx = (x - pad) % cell;
      const ly = (y - pad) % cell;
      const tile = inGrid && lx >= gap / 2 && lx < cell - gap / 2 && ly >= gap / 2 && ly < cell - gap / 2;
      const col = tile ? FG : BG;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
      raw[o + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(out + 'icon-192.png', png(192, 0.22, true));
writeFileSync(out + 'icon-512.png', png(512, 0.22, true));
// Maskable: full-bleed background, content inside the central safe zone (80 %).
writeFileSync(out + 'maskable-512.png', png(512, 0.3, false));
// iOS applies its own rounding and dislikes transparency.
writeFileSync(out + 'apple-touch-icon.png', png(180, 0.22, false));
