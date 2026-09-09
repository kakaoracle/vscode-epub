/**
 * 生成扩展图标 media/icon.png（128x128 RGBA PNG）。
 * 零依赖：手写 PNG 编码 + zlib deflate。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 4 + 1);
    raw[dst] = 0; // filter: none
    rgba.copy(raw, dst + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 绘图 ---------------- */

function inRRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
  const cornerX = px < x + r || px > x + w - r;
  const cornerY = py < y + r || py > y + h - r;
  if (cornerX && cornerY) {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function main() {
  const buf = Buffer.alloc(SIZE * SIZE * 4, 0);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // 背景：圆角矩形，蓝灰渐变
      if (inRRect(x, y, 6, 6, 116, 116, 26)) {
        const t = (y - 6) / 116;
        r = Math.round(45 + t * 20);
        g = Math.round(110 + t * 10);
        b = Math.round(215 + t * 20);
        a = 255;
      }

      // 打开的书：两页（梯形），浅色纸面
      const leftPage = [
        [22, 38],
        [62, 30],
        [62, 100],
        [22, 92]
      ];
      const rightPage = [
        [106, 38],
        [66, 30],
        [66, 100],
        [106, 92]
      ];
      if (inPoly(x, y, leftPage) || inPoly(x, y, rightPage)) {
        r = 250;
        g = 249;
        b = 245;
        a = 255;
      }

      // 中缝阴影
      if (y >= 30 && y <= 100 && Math.abs(x - 64) < 2.2) {
        r = 120;
        g = 160;
        b = 225;
        a = 255;
      }

      // 页上的文字线
      const lines = [46, 58, 70, 82];
      for (const ly of lines) {
        if (y >= ly && y < ly + 3.5) {
          const inLeft = x >= 30 && x <= 56;
          const inRight = x >= 72 && x <= 98;
          if (inLeft || inRight) {
            r = 120;
            g = 158;
            b = 214;
            a = 255;
          }
        }
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }

  const out = path.join(__dirname, '..', 'media', 'icon.png');
  fs.writeFileSync(out, encodePng(SIZE, SIZE, buf));
  console.log('已生成图标:', out, fs.statSync(out).size, 'bytes');
}

main();
