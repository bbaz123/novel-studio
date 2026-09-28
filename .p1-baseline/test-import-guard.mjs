#!/usr/bin/env node
/**
 * test-import-guard.mjs —— R12「导入 = 不可信输入」的隔离测试（零计费）。
 *
 * 覆盖任务书 §15 的验收判据：
 *   A. 纯模块：归档条目名策略（绝对路径 / `../` 穿越 / 反斜杠 / 深度 / 长度 / 控制字符）、
 *      相对路径解析（合法 `..` 允许、越界拒绝）、symlink / 压缩方式 / 压缩比 / 体积上限、
 *      严格 UTF-8 解码（非法编码失败、BOM、NUL）、文本与拆章结果上限。
 *   B. 端到端（隔离实例）：TXT / Markdown / EPUB 三种基线格式**不倒退**；
 *      畸形归档（穿越 / 绝对路径 / symlink / 压缩炸弹 / 条目爆炸 / 截断 / 非 UTF-8 正文）安全失败；
 *      任何失败都**不产生半导入状态**（作品数、章节数不变）；导入 HTML 走剥标签路径（不执行脚本、不抓远程资源）；
 *      判据口径可从 `GET /api/import/guard` 读回（可审计）。
 *
 * 用法: node .p1-baseline/test-import-guard.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import {
  IMPORT_LIMITS, IMPORT_RULES, IMPORT_GUARD_VERSION, normalizeArchiveName, resolveArchivePath,
  assertArchiveEntry, decodeTextStrict, assertImportText, assertChapters,
} from '../ai/import/guard.mjs';
import { readZip } from '../zip-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(7200 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(7200 + (process.pid % 300)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-import-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(String(e.message)) : true; } };

// ══════════════════ A. 纯模块 ══════════════════
console.log('【A. 归档条目策略 / 解码 / 上限（纯模块）】');
{
  ok('A1 合法条目名原样通过（含子目录与 ./ 归一）',
    normalizeArchiveName('OEBPS/Text/ch1.xhtml') === 'OEBPS/Text/ch1.xhtml'
      && normalizeArchiveName('./OEBPS//x.html') === 'OEBPS/x.html');
  ok('A2 路径穿越 / 绝对路径 / 盘符 / 反斜杠 / 控制字符 / URL 一律拒绝',
    throws(() => normalizeArchiveName('../evil.txt'), /上级目录引用/)
      && throws(() => normalizeArchiveName('a/../../b'), /上级目录引用/)
      && throws(() => normalizeArchiveName('/etc/passwd'), /绝对路径/)
      && throws(() => normalizeArchiveName('C:/win.ini'), /盘符/)
      && throws(() => normalizeArchiveName('a\\b.txt'), /反斜杠/)
      && throws(() => normalizeArchiveName('a\u0001b.txt'), /控制字符/)
      && throws(() => normalizeArchiveName('http://x/y.txt'), /URL/));
  ok('A3 过长 / 过深 / 空名 / 纯分隔符拒绝',
    throws(() => normalizeArchiveName('a'.repeat(IMPORT_LIMITS.max_entry_name_chars + 1)), /超过/)
      && throws(() => normalizeArchiveName(Array.from({ length: IMPORT_LIMITS.max_path_depth + 2 }, (_, i) => 'd' + i).join('/')), /深度/)
      && throws(() => normalizeArchiveName(''), /空名/)
      && throws(() => normalizeArchiveName('///'), /绝对路径|空/));
  ok('A4 相对路径解析：合法 ../ 允许（不因出现 .. 就误判），越界拒绝',
    resolveArchivePath('OEBPS/', '../Text/ch1.xhtml') === 'Text/ch1.xhtml'
      && resolveArchivePath('OEBPS/Text/', 'ch1.xhtml') === 'OEBPS/Text/ch1.xhtml'
      && throws(() => resolveArchivePath('OEBPS/', '../../x.xhtml'), /越出归档根/)
      && throws(() => resolveArchivePath('', '/etc/x'), /绝对路径/)
      && throws(() => resolveArchivePath('', 'http://evil/x'), /URL/));
  ok('A5 条目策略：symlink / 未知压缩方式 / 压缩炸弹 / 超大条目 / 空压缩数据全部拒绝',
    throws(() => assertArchiveEntry({ name: 'a.txt', method: 0, compSize: 10, uncompSize: 10, versionMadeBy: 0x031e, externalAttrs: (0xa1ff << 16) >>> 0 }), /symlink/)
      && throws(() => assertArchiveEntry({ name: 'a.txt', method: 12, compSize: 10, uncompSize: 10 }), /压缩方式/)
      && throws(() => assertArchiveEntry({ name: 'a.txt', method: 8, compSize: 100, uncompSize: 100 * (IMPORT_LIMITS.max_compression_ratio + 1) }), /压缩比/)
      && throws(() => assertArchiveEntry({ name: 'a.txt', method: 0, compSize: 10, uncompSize: IMPORT_LIMITS.max_entry_uncompressed + 1 }), /单条目上限/)
      && throws(() => assertArchiveEntry({ name: 'a.txt', method: 8, compSize: 0, uncompSize: 5 }), /压缩数据为空/));
  ok('A6 目录条目允许且不进内容表（目录名以 / 结尾）',
    assertArchiveEntry({ name: 'OEBPS/', method: 0, compSize: 0, uncompSize: 0 }).directory === true);
  ok('A7 严格 UTF-8：合法通过（BOM 去掉）、非法编码 / NUL / 超长拒绝',
    decodeTextStrict(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('第一章')]), { label: 't' }) === '第一章'
      && throws(() => decodeTextStrict(Buffer.from([0xc3, 0x28]), { label: 't' }), /不是合法 UTF-8/)
      && throws(() => decodeTextStrict(Buffer.from('a\u0000b'), { label: 't' }), /NUL/)
      && throws(() => decodeTextStrict(Buffer.from('x'.repeat(50)), { label: 't', maxChars: 10 }), /超过长度上限/));
  ok('A8 文本校验：空 / 二进制控制字符 / 超长拒绝',
    assertImportText('第一章\n正文') === '第一章\n正文'
      && throws(() => assertImportText('   '), /为空/)
      && throws(() => assertImportText('a\u0007b'), /控制字符/)
      && throws(() => assertImportText('x'.repeat(IMPORT_LIMITS.max_text_chars + 1)), /超过上限/));
  ok('A9 拆章结果校验：空 / 章节过多 / 单章过长 / 总量过大拒绝',
    assertChapters([{ title: 'a', content: 'x' }]).chapters === 1
      && throws(() => assertChapters([]), /没有章节/)
      && throws(() => assertChapters(Array.from({ length: IMPORT_LIMITS.max_chapters + 1 }, () => ({ content: 'x' }))), /章节数超过上限/)
      && throws(() => assertChapters([{ content: 'x'.repeat(IMPORT_LIMITS.max_chapter_chars + 1) }]), /单章上限/));
  ok('A10 判据口径机器可读（编码 / 路径 / symlink / 压缩比 / 不联网 / 零临时目录 / 原子写入）',
    IMPORT_RULES.version === IMPORT_GUARD_VERSION && /UTF-8/.test(IMPORT_RULES.encoding) && /symlink/.test(IMPORT_RULES.symlink)
      && /压缩比/.test(IMPORT_RULES.ratio) && /不发起任何外部请求/.test(IMPORT_RULES.network)
      && /零临时目录/.test(IMPORT_RULES.temp_isolation) && /单个事务/.test(IMPORT_RULES.atomic));
}

// ══════════════════ 隔离实例 ══════════════════
let server = null;
let serverLog = '';
const jfetch = async (path, { method = 'GET', body, headers = {}, timeout = 30000 } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
};
function cleanup() { try { if (server) server.kill(); } catch (_) {} try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} }
process.on('exit', cleanup);

server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'enh-import-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { if ((await jfetch('/api/novel/ping', { timeout: 2000 })).status === 200) ready = true; } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 250));
}
if (!ready) { console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000)); cleanup(); process.exit(2); }

/** 造一个最小合法 ZIP（stored + deflate 混用），支持自定义条目属性（symlink / 声明体积）。 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(String(e.name), 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data || ''), 'utf8');
    const method = e.method === 0 ? 0 : 8;
    const comp = method === 0 ? raw : deflateRawSync(raw);
    const uncompSize = e.declaredUncompSize !== undefined ? e.declaredUncompSize : raw.length;
    const crc = 0;
    const versionMadeBy = e.versionMadeBy !== undefined ? e.versionMadeBy : 20;
    const externalAttrs = e.externalAttrs !== undefined ? e.externalAttrs : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const epubOf = (files) => makeZip([
  { name: 'mimetype', data: 'application/epub+zip', method: 0 },
  { name: 'META-INF/container.xml', data: `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`, method: 8 },
  { name: 'OEBPS/content.opf', data: `<?xml version="1.0"?><package><metadata><dc:title>导入守卫·雾城</dc:title></metadata><manifest>${files.map((f, i) => `<item id="c${i}" href="${f.href || f.name.replace(/^OEBPS\//, '')}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${files.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`, method: 8 },
  ...files.map((f) => ({ name: f.name, data: f.data, method: f.method === undefined ? 8 : f.method })),
]);
const worksCount = async () => (await jfetch('/api/works')).data.length;
const chaptersCount = async (workId) => (await jfetch(`/api/chapters?work_id=${workId}`)).data.length;

try {
  console.log(`\n导入安全隔离测试（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
  const works0 = await worksCount();

  // ── B1/B2 基线格式不倒退：TXT / Markdown ──
  {
    const txt = '《守卫测试》\n\n第一章 初入\n这里是第一章正文。\n\n第二章 远行\n这里是第二章正文。';
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '守卫TXT', text: txt } });
    ok('B1 TXT 导入仍工作（自动拆章 + 守卫版本回执）',
      r.status === 201 && r.data.chapters === 2 && r.data.guard?.format === 'text' && r.data.guard.guard_version === IMPORT_GUARD_VERSION,
      JSON.stringify(r.data).slice(0, 160));
    const md = '# 我的书\n\n## 第一章 起风\n正文一。\n\n## 第二章 落雨\n正文二。';
    const r2 = await jfetch('/api/import', { method: 'POST', body: { title: '', text: md } });
    const chs = r2.data.work_id ? (await jfetch(`/api/chapters?work_id=${r2.data.work_id}`)).data : [];
    ok('B2 Markdown 导入仍工作（同一条拆章管道，未另建格式管道）',
      r2.status === 201 && r2.data.chapters >= 1 && chs.length === r2.data.chapters, JSON.stringify(r2.data).slice(0, 120));
  }

  // ── B3 EPUB 基线格式不倒退 + HTML 剥标签（不执行脚本 / 不抓远程资源）──
  {
    const epub = epubOf([
      { name: 'OEBPS/ch1.xhtml', data: '<html><body><h1>第一章 雾</h1><p>雾城的钟响了。</p><script>window.evil=1</script><img src="http://evil.example/x.png"/></body></html>' },
      { name: 'OEBPS/ch2.xhtml', data: '<html><body><h2>第二章 雨</h2><p>雨落下来。</p></body></html>' },
    ]);
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '', base64: epub.toString('base64') } });
    const chs = r.data.work_id ? (await jfetch(`/api/chapters?work_id=${r.data.work_id}`)).data : [];
    const content = chs.map((c) => String(c.content || '')).join('\n');
    ok('B3 EPUB 导入仍工作（spine 拆章 + 元数据标题 + 守卫回执）',
      r.status === 201 && r.data.chapters === 2 && r.data.title === '导入守卫·雾城' && r.data.guard?.format === 'epub',
      JSON.stringify(r.data).slice(0, 160));
    ok('B3b 导入 HTML 走剥标签路径：script/img/远程 URL 一个都不进正文',
      !/<script/i.test(content) && !/<img/i.test(content) && !/evil\.example/.test(content) && !/window\.evil/.test(content)
        && content.includes('雾城的钟响了'), content.slice(0, 120));
    ok('B3c 正文是转义后的编辑器 HTML（段落结构保留，标签不可注入）',
      /<p>/.test(content) && !/<h1>/i.test(content));
  }

  // ── B4–B9 畸形归档：安全失败且不留半个作品 ──
  const expectReject = async (name, zip, re, status = 400) => {
    const before = await worksCount();
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '畸形包', base64: zip.toString('base64') } });
    const after = await worksCount();
    ok(name, r.status === status && before === after, `status=${r.status} before=${before} after=${after} msg=${String(r.data.error || '').slice(0, 90)}`);
    if (re && !re.test(String(r.data.error || ''))) fails.push(name + '（错误信息未点明原因）');
  };
  const wrap = (entryName) => epubOf([{ name: entryName, href: 'ch1.xhtml', data: '<html><body><p>穿越</p></body></html>' }]);
  await expectReject('B4 条目名带 ../ → 拒绝（路径穿越），无半导入', wrap('../evil.xhtml'), /上级目录引用|穿越/);
  await expectReject('B5 条目名绝对路径 → 拒绝，无半导入', wrap('/etc/passwd'), /绝对路径/);
  {
    const zip = makeZip([
      { name: 'mimetype', data: 'application/epub+zip', method: 0 },
      { name: 'META-INF/container.xml', data: `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>` },
      { name: 'OEBPS/content.opf', data: `<?xml version="1.0"?><package><metadata><dc:title>symlink 包</dc:title></metadata><manifest><item id="c0" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/></spine></package>` },
      { name: 'OEBPS/ch1.xhtml', data: '<html><body><p>x</p></body></html>' },
      { name: 'OEBPS/link.xhtml', data: '/etc/passwd', versionMadeBy: 0x031e, externalAttrs: (0xa1ff << 16) >>> 0 },
    ]);
    await expectReject('B6 归档含 symlink 条目 → 拒绝（不跟随、不解压）', zip, /symlink/);
  }
  {
    const bomb = makeZip([{ name: 'OEBPS/big.xhtml', data: Buffer.alloc(1024 * 1024, 0x41), method: 8 }]);
    const before = await worksCount();
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '炸弹', base64: bomb.toString('base64') } });
    ok('B7 压缩炸弹（压缩比超限）→ 拒绝，无半导入',
      r.status === 400 && /压缩比/.test(String(r.data.error || '')) && before === (await worksCount()),
      `status=${r.status} msg=${String(r.data.error || '').slice(0, 90)}`);
  }
  {
    const many = Array.from({ length: IMPORT_LIMITS.max_archive_entries + 1 }, (_, i) => ({ name: `a/f${i}.txt`, data: 'x' }));
    const zip = makeZip(many);
    const before = await worksCount();
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '条目爆炸', base64: zip.toString('base64') } });
    ok('B8 条目数超过上限 → 拒绝，无半导入',
      r.status === 400 && /条目数超过上限/.test(String(r.data.error || '')) && before === (await worksCount()),
      `status=${r.status} msg=${String(r.data.error || '').slice(0, 90)}`);
  }
  {
    const zip = epubOf([{ name: 'OEBPS/ch1.xhtml', data: '<html><body><p>截断</p></body></html>' }]);
    const broken = zip.subarray(0, Math.floor(zip.length / 2));
    await expectReject('B9 归档被截断（目录损坏）→ 拒绝，无半导入', broken, /不是有效|损坏|缺少/);
  }
  {
    const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]); // GBK 的「第一章」，不是合法 UTF-8
    const zip = epubOf([{ name: 'OEBPS/ch1.xhtml', data: Buffer.concat([Buffer.from('<html><body><p>'), gbk, Buffer.from('</p></body></html>')]) }]);
    const before = await worksCount();
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '非 UTF-8', base64: zip.toString('base64') } });
    ok('B10 EPUB 正文不是合法 UTF-8 → 安全失败（不猜编码、不写乱码），无半导入',
      r.status === 400 && /UTF-8/.test(String(r.data.error || '')) && before === (await worksCount()),
      `status=${r.status} msg=${String(r.data.error || '').slice(0, 110)}`);
  }

  // ── B11–B13 文本侧上限与"不产生半导入" ──
  {
    const many = Array.from({ length: IMPORT_LIMITS.max_chapters + 1 }, (_, i) => `第${i + 1}章 标题\n正文。`).join('\n\n');
    const before = [await worksCount(), 0];
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '章太多', text: many } });
    ok('B11 文本导入章节数超上限 → 拒绝，无半导入',
      r.status === 400 && /章节数超过上限/.test(String(r.data.error || '')) && before[0] === (await worksCount()),
      `status=${r.status} msg=${String(r.data.error || '').slice(0, 90)}`);
    const bin = await jfetch('/api/import', { method: 'POST', body: { title: '二进制', text: '第一章\n正文\u0007乱码' } });
    ok('B12 文本含二进制控制字符 → 拒绝（不把垃圾写进正文）',
      bin.status === 400 && /控制字符/.test(String(bin.data.error || '')), `status=${bin.status} msg=${String(bin.data.error || '').slice(0, 80)}`);
    const empty = await jfetch('/api/import', { method: 'POST', body: { title: '空', text: '   ' } });
    ok('B13 空文本 → 400（与守卫判据一致）', empty.status === 400, `status=${empty.status}`);
  }
  {
    // 文本上限 8M 字符 < 文件上限，所以用 base64 走归档分支验证「文件体积上限」。
    const before = await worksCount();
    const huge = 'x'.repeat(24 * 1024 * 1024 + 1024);
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '超大', base64: Buffer.from(huge).toString('base64') } });
    ok('B14 超过导入文件上限 → 413 且点明上限，无半导入',
      r.status === 413 && /过大|上限/.test(String(r.data.error || '')) && before === (await worksCount()),
      `status=${r.status} msg=${String(r.data.error || '').slice(0, 80)}`);
  }
  {
    // 传输层上限：请求体 > 36MB。历史上这里是 req.destroy()，客户端只能看到连接被重置（真因不可见）。
    const before = await worksCount();
    const out = await new Promise((res2) => {
      const rq = http.request({
        host: '127.0.0.1', port: PORT, path: '/api/import', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(40 * 1024 * 1024) }
      }, (rs) => {
        let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => res2({ status: rs.statusCode, body: d }));
      });
      rq.on('error', (e) => res2({ status: 0, body: String(e.message) }));
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      let sent = 0;
      const pump = () => {
        while (sent < 40 * 1024 * 1024) { sent += chunk.length; if (!rq.write(chunk)) { rq.once('drain', pump); return; } }
        rq.end();
      };
      pump();
    });
    ok('B14b 声明超限的请求体也拿到明确 413（不是连接重置/网络错误），无半导入',
      out.status === 413 && /过大|上限/.test(out.body) && before === (await worksCount()),
      `status=${out.status} body=${out.body.slice(0, 90)}`);
  }
  {
    const before = await worksCount();
    const r = await jfetch('/api/import', { method: 'POST', body: { title: '坏 base64', base64: '!!!not-base64!!!' } });
    ok('B15 非法 base64 → 400（既有行为不变）', r.status === 400 && before === (await worksCount()), `status=${r.status}`);
  }

  // ── B16 判据可审计（只读端点）──
  {
    const g = await jfetch('/api/import/guard');
    ok('B16 GET /api/import/guard 读回版本 / 上限 / 口径（含压缩比与 symlink 与零临时目录）',
      g.status === 200 && g.data.version === IMPORT_GUARD_VERSION && g.data.limits.max_compression_ratio === IMPORT_LIMITS.max_compression_ratio
        && /symlink/.test(JSON.stringify(g.data.rules)) && /零临时目录/.test(JSON.stringify(g.data.rules)),
      JSON.stringify(g.data).slice(0, 120));
  }

  // ── B17 正常 EPUB 的条目类型判定仍可用（readZip 直接复核）──
  {
    const zip = epubOf([{ name: 'OEBPS/ch1.xhtml', data: '<html><body><p>ok</p></body></html>', method: 0 }]);
    const entries = readZip(zip);
    ok('B17 readZip 仍返回规范化后的条目表（stored/deflate 混用、目录条目不入表）',
      entries.get('META-INF/container.xml') && entries.get('OEBPS/ch1.xhtml')?.toString().includes('<p>ok</p>') && !entries.has('OEBPS/'));
  }
} catch (e) {
  fails.push('异常：' + e.message);
  console.error('✗ 测试异常：', e && e.stack ? e.stack : e);
} finally {
  cleanup();
}

console.log(`\n导入安全（R12）：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：'); for (const f of fails) console.log('  - ' + f); process.exit(1); }