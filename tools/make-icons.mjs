// Generates the PNG app icons with no dependencies:  node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) { const [r, g, b, a] = draw(x / size, y / size); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const heights = [0.18, 0.34, 0.55, 0.3, 0.72, 0.46, 0.62, 0.26, 0.4, 0.2];
// scale = how much of the canvas the artwork uses (maskable icons need a safe zone); round = rounded corners
const icon = (scale, round) => (u, v) => {
  if (round) { const r = 0.2, cx = Math.min(u, 1 - u), cy = Math.min(v, 1 - v); if (cx < r && cy < r && Math.hypot(r - cx, r - cy) > r) return [0, 0, 0, 0]; }
  const bg = mix([124, 92, 255], [20, 16, 60], v);
  const x = (u - 0.5) / scale + 0.5, y = (v - 0.5) / scale + 0.5;
  const left = 0.17, right = 0.83, n = heights.length, slot = (right - left) / n;
  if (x >= left && x < right) {
    const i = Math.floor((x - left) / slot), local = (x - left) / slot - i;
    if (local > 0.2 && local < 0.8 && Math.abs(y - 0.5) < heights[i] / 2) return [...mix([46, 230, 166], [255, 255, 255], 0.15 * i / n), 255];
  }
  return [...bg, 255];
};
mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon-192.png', png(192, icon(1, true)));
writeFileSync('icons/icon-512.png', png(512, icon(1, true)));
writeFileSync('icons/apple-touch-icon.png', png(180, icon(1, false)));
writeFileSync('icons/icon-maskable-512.png', png(512, icon(0.72, false)));
console.log('icons written');
