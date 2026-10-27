// Generates simple PNG app icons with no dependencies.
// Usage: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const BG = [59, 91, 219]; // #3b5bdb
const FG = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Distance from point to segment, for the clock hands.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const c = size / 2;
  const ringR = size * 0.27, ringW = size * 0.055, handW = size * 0.04;
  const SS = 3; // supersampling for smooth edges
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          const ring = Math.abs(Math.hypot(px - c, py - c) - ringR) <= ringW / 2;
          const h1 = segDist(px, py, c, c, c, c - ringR * 0.62) <= handW / 2;
          const h2 = segDist(px, py, c, c, c + ringR * 0.45, c + ringR * 0.2) <= handW / 2;
          if (ring || h1 || h2) cover++;
        }
      }
      const a = cover / (SS * SS);
      for (let i = 0; i < 3; i++) raw[o++] = Math.round(BG[i] + (FG[i] - BG[i]) * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const [name, size] of [["icon-192", 192], ["icon-512", 512], ["apple-touch-icon", 180]]) {
  writeFileSync(`public/icons/${name}.png`, render(size));
  console.log(`wrote public/icons/${name}.png`);
}
