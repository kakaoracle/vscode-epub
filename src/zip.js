'use strict';
/**
 * 极简 ZIP 读取器（零依赖，基于 Node 内置 zlib）。
 * EPUB 本质就是一个 zip 包，只需要支持 stored(0) / deflate(8) 两种压缩方式。
 */

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;
const SIG_Z64_EOCD = 0x07064b50;
const SIG_Z64_LOC = 0x07064b50;

class ZipReader {
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    this.buf = buffer;
    /** @type {Map<string, {name:string, method:number, compressedSize:number, size:number, offset:number, crc:number}>} */
    this.entries = new Map();
    this._readCentralDirectory();
  }

  _findSignature(sig, searchBackBytes) {
    const buf = this.buf;
    const start = Math.max(0, buf.length - searchBackBytes);
    for (let i = buf.length - 22; i >= start; i--) {
      if (buf.readUInt32LE(i) === sig) return i;
    }
    return -1;
  }

  _readCentralDirectory() {
    const buf = this.buf;
    let eocd = this._findSignature(SIG_EOCD, 66 * 1024);
    if (eocd < 0) throw new Error('不是有效的 zip/EPUB 文件（未找到结尾记录）');

    let entryCount = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    // ZIP64 支持
    if (cdOffset === 0xffffffff || entryCount === 0xffff) {
      const z64 = this._findSignature(SIG_Z64_EOCD, 66 * 1024);
      if (z64 >= 0) {
        entryCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }

    let pos = cdOffset;
    for (let n = 0; n < entryCount; n++) {
      if (pos + 46 > buf.length) break;
      if (buf.readUInt32LE(pos) !== SIG_CDH) break;

      const flags = buf.readUInt16LE(pos + 8);
      const method = buf.readUInt16LE(pos + 10);
      const compressedSize = buf.readUInt32LE(pos + 20);
      const size = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      let localOffset = buf.readUInt32LE(pos + 42);

      const nameBytes = buf.slice(pos + 46, pos + 46 + nameLen);
      const name = (flags & 0x800) ? nameBytes.toString('utf8') : nameBytes.toString('utf8');

      // 从 extra field 中读取 ZIP64 扩展值
      let realCompressed = compressedSize;
      let realSize = size;
      let realOffset = localOffset;
      const extraEnd = pos + 46 + nameLen + extraLen;
      let ep = pos + 46 + nameLen;
      while (ep + 4 <= extraEnd) {
        const headerId = buf.readUInt16LE(ep);
        const dataSize = buf.readUInt16LE(ep + 2);
        const data = buf.slice(ep + 4, ep + 4 + dataSize);
        if (headerId === 0x0001) {
          let off = 0;
          if (realSize === 0xffffffff && off + 8 <= data.length) { realSize = Number(data.readBigUInt64LE(off)); off += 8; }
          if (realCompressed === 0xffffffff && off + 8 <= data.length) { realCompressed = Number(data.readBigUInt64LE(off)); off += 8; }
          if (realOffset === 0xffffffff && off + 8 <= data.length) { realOffset = Number(data.readBigUInt64LE(off)); }
        }
        ep += 4 + dataSize;
      }

      if (buf.readUInt32LE(realOffset) !== SIG_LFH) {
        pos += 46 + nameLen + extraLen + commentLen;
        continue;
      }

      this.entries.set(name, {
        name,
        method,
        compressedSize: realCompressed,
        size: realSize,
        offset: realOffset,
        crc: buf.readUInt32LE(pos + 16)
      });

      pos += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** 列出所有条目名 */
  names() {
    return Array.from(this.entries.keys());
  }

  has(name) {
    if (this.entries.has(name)) return true;
    // 容忍大小写/编码差异
    const lower = name.toLowerCase();
    for (const key of this.entries.keys()) {
      if (key.toLowerCase() === lower) return true;
    }
    return false;
  }

  _resolve(name) {
    if (this.entries.has(name)) return this.entries.get(name);
    const lower = name.toLowerCase();
    for (const [key, value] of this.entries) {
      if (key.toLowerCase() === lower) return value;
    }
    return null;
  }

  /** 读取并解压指定条目，返回 Buffer；不存在返回 null */
  read(name) {
    const entry = this._resolve(name);
    if (!entry) return null;

    const buf = this.buf;
    const nameLen = buf.readUInt16LE(entry.offset + 26);
    const extraLen = buf.readUInt16LE(entry.offset + 28);
    const dataStart = entry.offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    const raw = buf.slice(dataStart, Math.min(dataEnd, buf.length));

    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      try {
        return zlib.inflateRawSync(raw);
      } catch (err) {
        // 某些打包器写入了带 zlib 头的流，回退一次
        return zlib.inflateSync(raw);
      }
    }
    throw new Error(`不支持的压缩方式: ${entry.method}（文件 ${name}）`);
  }

  /** 读取指定条目并按 UTF-8 解码为字符串 */
  readText(name, encoding = 'utf8') {
    const data = this.read(name);
    if (data === null) return null;
    const text = data.toString(encoding);
    // 若声明了 GBK 编码，尝试用 TextDecoder 兜底
    return text;
  }
}

module.exports = { ZipReader };
