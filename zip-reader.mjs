/**
 * zip-reader.mjs — 零依赖最小 ZIP 读取器（EPUB 导入用）。
 * 支持 stored(0) 与 deflate(8) 两种条目；从 End of Central Directory 反查中央目录。
 * 只读取不解压到磁盘：返回 Map<条目名, Buffer>。
 */
import { inflateRawSync } from 'node:zlib';

export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new Error('文件太小，不是有效的 ZIP/EPUB');
  let eocd = -1;
  const maxScan = Math.min(buf.length, 22 + 65535 + 1024);
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件（缺少目录结构）');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 本地头损坏：${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error(`ZIP 数据区损坏（${name}）：压缩数据越界`);
    }
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`不支持的 ZIP 压缩方式 ${method}`);
    } catch (e) {
      throw new Error(`解压失败（${name}）：${e.message}`);
    }
    entries.set(name, data);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export default readZip;
