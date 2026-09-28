/**
 * zip-reader.mjs — 零依赖最小 ZIP 读取器（EPUB 导入用）。
 * 支持 stored(0) 与 deflate(8) 两种条目；从 End of Central Directory 反查中央目录。
 * 只读取不解压到磁盘：返回 Map<条目名, Buffer>。
 *
 * R12 硬化（2026-09-27）：归档是不可信输入，读取前先过 `ai/import/guard.mjs` 的条目策略：
 *   - 路径：拒绝绝对路径 / `../` 穿越 / 反斜杠 / 控制字符 / 过深 / 过长（不写盘，但据此拒绝整包）；
 *   - symlink：`versionMadeBy` 为 Unix 时按 external attributes 判 symlink，一律拒绝；
 *   - 数量与体积：条目数、单条目解压、整包解压总量和**压缩比**都有上限（压缩炸弹）；
 *   - 只接受 stored(0) / deflate(8)；解压失败 / 越界 / 目录损坏 → 抛错（安全失败，不返回半个包）。
 */
import { inflateRawSync } from 'node:zlib';
import { IMPORT_LIMITS, assertArchiveEntry } from './ai/import/guard.mjs';

const MAX_ENTRY_UNCOMPRESSED = IMPORT_LIMITS.max_entry_uncompressed;
const MAX_TOTAL_UNCOMPRESSED = IMPORT_LIMITS.max_total_uncompressed;

export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new Error('文件太小，不是有效的 ZIP/EPUB');
  if (buf.length > IMPORT_LIMITS.max_file_bytes) {
    throw new Error(`归档文件过大（${buf.length} 字节 > ${IMPORT_LIMITS.max_file_bytes}）`);
  }
  let eocd = -1;
  const maxScan = Math.min(buf.length, 22 + 65535 + 1024);
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件（缺少目录结构）');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > IMPORT_LIMITS.max_archive_entries) {
    throw new Error(`归档条目数超过上限（${count} > ${IMPORT_LIMITS.max_archive_entries}）`);
  }
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let totalUncompressed = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const versionMadeBy = buf.readUInt16LE(offset + 4);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLen + extraLen + commentLen > buf.length) {
      throw new Error('ZIP 中央目录损坏（条目元数据越界）');
    }
    const rawName = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    // 条目策略（名字 / symlink / 压缩方式 / 压缩比 / 单条目大小）单点在 guard 里；这里只用结果。
    const policy = assertArchiveEntry({ name: rawName, method, compSize, uncompSize, externalAttrs, versionMadeBy });
    if (totalUncompressed + uncompSize > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error('ZIP 解压总量超过上限，已拒绝继续解压');
    }
    if (!policy.directory) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`ZIP 本地头损坏：${policy.name}`);
      }
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > buf.length) {
        throw new Error(`ZIP 数据区损坏（${policy.name}）：压缩数据越界`);
      }
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let data;
      try {
        if (method === 0) data = Buffer.from(raw);
        else data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED });
      } catch (e) {
        throw new Error(`解压失败（${policy.name}）：${e.message}`);
      }
      if (data.length > MAX_ENTRY_UNCOMPRESSED) {
        throw new Error(`ZIP 条目解压后过大（${policy.name}）：${data.length} 字节`);
      }
      if (totalUncompressed + data.length > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error('ZIP 解压总量超过上限，已拒绝继续解压');
      }
      totalUncompressed += data.length;
      entries.set(policy.name, data);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export default readZip;