/**
 * 无依赖生成 Daynora 的 PNG / ICO 图标。
 * 设计：陶土色圆角方底 + 奶油色对勾。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'src-tauri', 'icons');

const COLORS = {
  terracotta: [184, 84, 47, 255],
  terracottaDark: [143, 60, 35, 255],
  cream: [255, 248, 239, 255],
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function blendPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = (y * size + x) * 4;
  const alpha = color[3] / 255;
  const inverse = 1 - alpha;
  pixels[index] = Math.round(color[0] * alpha + pixels[index] * inverse);
  pixels[index + 1] = Math.round(color[1] * alpha + pixels[index + 1] * inverse);
  pixels[index + 2] = Math.round(color[2] * alpha + pixels[index + 2] * inverse);
  pixels[index + 3] = Math.max(pixels[index + 3], color[3]);
}

function fillRoundRect(pixels, size, x0, y0, x1, y1, radius, colorAt) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
      const dx = Math.min(Math.max(x + 0.5 - (x0 + radius), 0), x1 - x0 - radius * 2);
      const dy = Math.min(Math.max(y + 0.5 - (y0 + radius), 0), y1 - y0 - radius * 2);
      const distance = Math.hypot(dx, dy);
      if (distance <= radius) blendPixel(pixels, size, x, y, colorAt(x, y));
    }
  }
}

function drawThickLine(pixels, size, x0, y0, x1, y1, thickness, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    const centerX = x0 + (x1 - x0) * t;
    const centerY = y0 + (y1 - y0) * t;
    const radius = thickness / 2;
    for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
      for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
        if (Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) <= radius) {
          blendPixel(pixels, size, x, y, color);
        }
      }
    }
  }
}

function createIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const inset = size * 0.055;
  fillRoundRect(
    pixels,
    size,
    inset,
    inset,
    size - inset,
    size - inset,
    size * 0.24,
    (_x, y) => (y < size * 0.5 ? COLORS.terracotta : COLORS.terracottaDark),
  );
  const thickness = Math.max(2, size * 0.075);
  const start = { x: size * 0.28, y: size * 0.52 };
  const middle = { x: size * 0.44, y: size * 0.68 };
  const end = { x: size * 0.73, y: size * 0.34 };
  drawThickLine(pixels, size, start.x, start.y, middle.x, middle.y, thickness, COLORS.cream);
  drawThickLine(pixels, size, middle.x, middle.y, end.x, end.y, thickness, COLORS.cream);
  return encodePng(size, size, pixels);
}

function createIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const entries = [16, 32, 48, 64, 128, 256].map((size) => ({
    size,
    png: createIcon(size),
  }));

  fs.writeFileSync(path.join(OUTPUT_DIR, '32x32.png'), entries.find((item) => item.size === 32).png);
  fs.writeFileSync(path.join(OUTPUT_DIR, '128x128.png'), entries.find((item) => item.size === 128).png);
  fs.writeFileSync(path.join(OUTPUT_DIR, '128x128@2x.png'), entries.find((item) => item.size === 256).png);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.png'), entries.find((item) => item.size === 256).png);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.ico'), createIco(entries));

  console.log(`已生成 Daynora 图标 -> ${OUTPUT_DIR}`);
}

main();
