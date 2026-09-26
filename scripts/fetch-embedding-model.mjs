// scripts/fetch-embedding-model.mjs
//
// 取回 OpenViking 本地向量模型（bge-small-zh-v1.5-f16.gguf）到工坊源码里。
//
// 为什么要有这个脚本：
//   工坊源码里已经带了一份模型（vendor/models/bge-small-zh-v1.5-f16.gguf），
//   正常情况**根本不需要运行本脚本**。它存在只为了两件事：
//     1) 有人 clone 时用了会跳过二进制、或误删了 vendor/models/ → 一条命令补回来；
//     2) 想核对「我这份模型和上游是不是同一份」→ --verify-only 逐字节算 SHA256。
//
// 为什么把下载地址写死在脚本里、而不是让人去 HuggingFace 点：
//   本机实测 huggingface.co 不可达（握手超时），hf-mirror.com 1.1 秒通；
//   两个地址都列出并按顺序试，失败原因全部打印，不静默。
//
// 用法：
//   node scripts/fetch-embedding-model.mjs                # 缺则下载，有则校验；幂等
//   node scripts/fetch-embedding-model.mjs --verify-only  # 只校验，不下载
//   node scripts/fetch-embedding-model.mjs --force        # 重新下载覆盖
//
// 退出码：0 = 就绪且校验通过；1 = 失败（不声称成功）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 模型元数据：文件名 / 字节数 / SHA256 全部是本机实测值，改版本时必须一起改。 */
export const MODEL = {
  file: 'bge-small-zh-v1.5-f16.gguf',
  bytes: 47886240,
  sha256: 'ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c',
  hfRepoPage: 'https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf',
  // 顺序即优先级：先镜像，后官网。
  urls: [
    'https://hf-mirror.com/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf',
    'https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true',
  ],
};

const destDir = path.join(ROOT, 'vendor', 'models');
const dest = path.join(destDir, MODEL.file);

const args = new Set(process.argv.slice(2));
const VERIFY_ONLY = args.has('--verify-only');
const FORCE = args.has('--force');

const log = (m) => console.log(`[model] ${m}`);
const fail = (m) => { console.error(`[model] 失败：${m}`); process.exit(1); };

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function describe(p) {
  const st = fs.statSync(p);
  return `${st.size} B`;
}

// ── 1) 已有的那份是不是对的那份 ──────────────────────────────────────────────
if (fs.existsSync(dest) && !FORCE) {
  const actual = sha256(dest);
  if (actual === MODEL.sha256) {
    log(`已就绪并校验通过：${path.relative(ROOT, dest)}（${describe(dest)}）`);
    log('不需要下载任何东西。');
    process.exit(0);
  }
  log(`内容不符，将重新下载：${path.relative(ROOT, dest)}`);
  log(`  实际 sha256 = ${actual}`);
  log(`  期望 sha256 = ${MODEL.sha256}`);
  if (VERIFY_ONLY) fail('--verify-only：文件存在但校验不过（上面两个哈希值不一致）');
}

if (VERIFY_ONLY) fail(`--verify-only：文件不存在：${dest}`);

// ── 2) 下载（逐个地址试，失败原因全部打印） ─────────────────────────────────
fs.mkdirSync(destDir, { recursive: true });
const errors = [];
let ok = false;
for (const url of MODEL.urls) {
  const t0 = Date.now();
  try {
    log(`下载 ${url}`);
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 先写临时文件再改名：中途崩掉不会留下一个"看起来存在、其实半截"的模型，
    // 那种文件会让 OpenViking 在加载期才炸，比早失败难查得多。
    const tmp = dest + '.part';
    fs.writeFileSync(tmp, buf);
    if (buf.length !== MODEL.bytes) throw new Error(`字节数不符：${buf.length} != ${MODEL.bytes}`);
    const actual = sha256(tmp);
    if (actual !== MODEL.sha256) throw new Error(`SHA256 不符：${actual}`);
    fs.renameSync(tmp, dest);
    log(`下载完成：${buf.length} B，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，校验通过`);
    ok = true;
    break;
  } catch (e) {
    errors.push(`${url}\n      → ${e.message}`);
    log(`这个地址不行：${e.message}`);
  }
}

if (!ok) {
  fail([
    '所有地址都失败了：',
    '  ' + errors.join('\n  '),
    '',
    '可以手动下载后放到下面这个路径（文件名必须一致）：',
    `  ${dest}`,
    `  期望字节数 = ${MODEL.bytes}`,
    `  期望 sha256 = ${MODEL.sha256}`,
    `  上游仓库页 = ${MODEL.hfRepoPage}`,
  ].join('\n'));
}

log(`就绪：${path.relative(ROOT, dest)}`);
