/**
 * scripts/nsdsh/lib/zip-archive.mjs —— R02：零依赖 ZIP 写入/解包（发行物用）。
 *
 * 为什么不用系统 `tar`/`zip`：发行物验证必须能在任何受信环境里跑，
 * 而"spawn 一个外部打包器"会引入平台差异（GNU tar / bsdtar / 无 tar 的精简镜像）
 * 与子进程权限问题（本项目的 E1 就是门禁侧拒绝 spawn 派生进程）。
 * 纯 Node 的 40 行格式代码比这些不确定性便宜。
 *
 * 为什么不用仓库里的 `zip-reader.mjs`：那个是**不可信输入**的读取器（带压缩炸弹与条目数上限，
 * 上限 2000 条）。发行物是我们自己产出的、体量固定的归档，套用用户导入的限制会误伤。
 * 两者用途不同，刻意分开。
 *
 * 支持范围（够用即止，明确不支持）：stored(0) / deflate(8)、无 zip64、无加密、
 * 单条目 < 4GB、总条目 < 65535。超出范围直接抛错，**不静默降级**。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX_ENTRIES = 65535;
const MAX_BYTES = 0xffffffff;

/** CRC-32（IEEE 802.3）查表实现。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间/日期。固定时间戳让归档可复现（同一输入 → 同一 SHA-256）。 */
export function dosDateTime(date = new Date(2026, 0, 1, 0, 0, 0)) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * 写 ZIP。
 *
 * @param entries `[{ name, data }]` —— `name` 必须是相对路径 + 正斜杠（构造期就校验）
 * @param options `{ level = 6, fixedTime = true }`
 * @returns Buffer
 */
export function writeZip(entries, { level = 6, fixedTime = true } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP_EMPTY');
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP_TOO_MANY_ENTRIES:${entries.length}`);
  const { time, day } = dosDateTime(fixedTime ? undefined : new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const rawName = String(e.name || '');
    // 条目名是安全边界：绝对路径 / .. 穿越 / 反斜杠一律拒绝（解包端还会再查一次）
    //
    // 反斜杠**直接拒绝**而不是悄悄归一化：Windows 风格路径本身就是"想穿越"的常见伪装，
    // 静默转换会让 `..\..\x` 先被归一化成 `../../x` 才拒绝，报错与真实意图脱节。
    const BACKSLASH_CH = String.fromCharCode(92);
    if (rawName.includes(BACKSLASH_CH)) throw new Error(`ZIP_BAD_ENTRY_NAME:${JSON.stringify(rawName)}`);
    const name = rawName;
    if (!name || name.startsWith('/') || name.includes('../') || name.includes('\0')) {
      throw new Error(`ZIP_BAD_ENTRY_NAME:${JSON.stringify(name)}`);
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    if (data.length > MAX_BYTES) throw new Error(`ZIP_ENTRY_TOO_LARGE:${name}`);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); // external attributes：**永不**写 symlink 位
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * 读 ZIP 并返回 `Map<name, Buffer>`。
 *
 * 与写入器对称，并且**同样拒绝**绝对路径 / `..` 穿越 / 反斜杠 / 非 stored|deflate 的方法。
 * 解包端的独立校验不是多余的：发行物在别人机器上可能被重新打包过。
 */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new Error('ZIP_TOO_SMALL');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP_NO_EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP_CENTRAL_CORRUPT');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (!name || name.startsWith('/') || name.includes('../') || name.includes('\\')) {
      throw new Error(`ZIP_BAD_ENTRY_NAME:${JSON.stringify(name)}`);
    }
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`ZIP_LOCAL_CORRUPT:${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`ZIP_UNSUPPORTED_METHOD:${method}:${name}`);
    if (data.length !== uncompSize) throw new Error(`ZIP_SIZE_MISMATCH:${name}`);
    if (crc32(data) !== crc) throw new Error(`ZIP_CRC_MISMATCH:${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 把 `Map<name, Buffer>` 落到磁盘（先做路径穿越检查，绝不写出目标目录）。 */
export function extractTo(entries, targetDir, { fs, path }) {
  const written = [];
  for (const [name, data] of entries) {
    const abs = path.resolve(targetDir, name);
    const rel = path.relative(targetDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`ZIP_PATH_ESCAPE:${name}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    written.push(name);
  }
  return written;
}
