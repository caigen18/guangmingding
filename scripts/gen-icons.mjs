// 生成 PWA 图标（192 / 512 / apple-touch-icon 180），与 public/icon.svg 同款几何图形。
// 用法：node scripts/gen-icons.mjs
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BG = [0x0f, 0x11, 0x15];
const GOLD = [0xb7, 0x8a, 0x4f];

function inside(cx, cy, x, y) {
  return x >= 0 && y >= 0 && x < cx && y < cy;
}

function dist(a, b, c, d) {
  return Math.sqrt((a - c) ** 2 + (b - d) ** 2);
}

function setPx(png, x, y, rgb) {
  const idx = (png.width * y + x) << 2;
  png.data[idx] = rgb[0];
  png.data[idx + 1] = rgb[1];
  png.data[idx + 2] = rgb[2];
  png.data[idx + 3] = 255;
}

function draw(size) {
  const png = new PNG({ width: size, height: size });
  const s = size / 512; // 以 512 设计稿为基准缩放
  const C = size / 2;

  // 背景
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) setPx(png, x, y, BG);

  const ringR = 150 * s;
  const ringW = 18 * s;
  const crossHalf = 126 * s;
  const crossW = 14 * s;
  const dotR = 44 * s;

  // 金色圆环（stroke）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = dist(x, y, C, C);
      if (d >= ringR - ringW / 2 && d <= ringR + ringW / 2) setPx(png, x, y, GOLD);
    }
  }

  // 十字（横向 + 纵向，带线宽）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.abs(x - C) <= crossW / 2 && y >= C - crossHalf && y <= C + crossHalf;
      const h = Math.abs(y - C) <= crossW / 2 && x >= C - crossHalf && x <= C + crossHalf;
      if (v || h) setPx(png, x, y, GOLD);
    }
  }

  // 中心圆点
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dist(x, y, C, C) <= dotR) setPx(png, x, y, GOLD);
    }
  }

  return png;
}

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];

for (const t of targets) {
  const buf = PNG.sync.write(draw(t.size));
  writeFileSync(join(ROOT, t.name), buf);
  console.log(`wrote public/${t.name} (${t.size}x${t.size}, ${buf.length} bytes)`);
}
