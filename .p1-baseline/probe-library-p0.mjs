#!/usr/bin/env node
/**
 * P0 探针（library 知识库）：唯一被允许写真实记忆库的一次性实验。
 *
 * 目的（对应待办《知识库》P0）：在冻结资料格式约定之前，用 1 个临时 md 实测：
 *   1. write 后多久能被 find 检索到（异步索引窗口）；
 *   2. find 命中的 abstract/overview 形状与分数（含 front matter 是否参与向量化）；
 *   3. `##` 分段是否成为切块边界（同一文件不同段的命中摘要是否不同）；
 *   4. readContent(limit 30) 实际取回什么（按行还是按块？含不含 front matter）。
 *
 * 安全纪律（对应待办中的红线）：
 *   · 只写 <共享资料根>/_probe/p0-format-probe.md 一个文件；写前确认不存在，跑完全删；
 *   · 删除后 readContent + find 双重复核；任何一步失败都要先尝试清理，再大声报告；
 *   · 直连 ovClient（不走 pending 队列）——服务器不可用时直接失败，绝不留待重放。
 *
 * 用法: node .p1-baseline/probe-library-p0.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ovClient } from '../openviking.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULT_FILE = path.join(HERE, 'probe-library-p0.result.json');

// 共享资料根（与待办文档一致；novel-studio 的兄弟目录，避免混入作品命名空间）
const ROOT = 'viking://user/default/resources/novel-studio-library';
const DIR = `${ROOT}/_probe`;
const URI = `${DIR}/p0-format-probe.md`;

// 唯一词：只出现一次、只出现于指定区域，用来判定「哪段被向量化/被取回」
const FM = 'ZQK7FM';
const INTRO = 'ZQK7INTRO';
const S1 = 'ZQK7SEC1';
const S2 = 'ZQK7SEC2';
const S2B = 'ZQK7SEC2B';
const S3 = 'ZQK7SEC3';
const S4 = 'ZQK7SEC4';
const S5 = 'ZQK7SEC5';
const NOPE = 'ZQK7NOsuchMARKER';

const CONTENT = [
  '---',
  'title: P0 格式探针',
  `probe_marker: ${FM}`,
  'tags: [格式探针, 临时文件]',
  '---',
  '',
  '# 格式探针：共享资料库 P0',
  '',
  `一句话结论：${INTRO} 本文件是知识库格式约定冻结前的一次性真机实验，验证切块、检索与读回行为；验证后立即删除。`,
  '适用场景：仅探针期间存在。',
  '',
  `## 第一节：北岭雪线的风向标（${S1}）`,
  '',
  `- ${S1} 本节只用来测「第一节能否被单独召回」。`,
  '- 雪线以上风速稳定，旗标指向与谷底相反。',
  '- 夜间结霜会把标绳冻成硬线，需要清晨先敲再拉。',
  '- 遇白雾时以绳结计数，不依赖目视距离。',
  '- 记录口令：每走两百步报一次绳结数。',
  '',
  `## 第二节：雾港潮汐的铜尺（${S2}）`,
  '',
  `- ${S2} 本节刻意写在文件中部，用来对比不同段的召回分数。`,
  '- 潮位以铜尺读数报出，尺身刻到半寸。',
  '- 大潮日退潮窗口短，进出港要错开。',
  '- 铜尺受热会伸长，读数需按温标修正。',
  '- 口令沿用旧例：先报潮位，再报风向。',
  '',
  `### 第二甲：补给清单（${S2B}）`,
  '',
  '- 绳、蜡、干粮、备尺。',
  '',
  `## 第三节：铜环律令的例外条款（${S3}）`,
  '',
  `- ${S3} 本节位于文件中后段，代表「后期才被召回的深段内容」。`,
  '- 律令第七条允许在雾季临时改线，但必须两人附议。',
  '- 例外条款只在铜环出示后生效。',
  '- 改线记录当日抄送港务厅备案。',
  '- 任何口头改线一律无效。',
  '',
  `## 第四节：旧城钟声的校对法（${S4}）`,
  '',
  `- ${S4} 本节用来验证中后段内容是否也能被召回。`,
  '- 钟声校对以三响为一组，组间停顿固定。',
  '- 雾天声速变化，校对要取双端平均。',
  '- 钟楼维护日停校一次，不补。',
  '- 校对记录按季度归档。',
  '',
  `## 第五节：尾声校样（${S5}）`,
  '',
  `- ${S5} 本节是最后一节，用来验证尾部内容的召回与取回窗口。`,
  '- 校样以蓝铅笔标记，只改错不润色。',
  '- 每一轮校样要留样张，编号连续。',
  '- 归档前复核页脚编码。',
  '',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { started_at: new Date().toISOString(), uri: URI };

const findHits = (q, opts = {}) => ovClient.find(q, { targetUri: ROOT, limit: 10, scoreThreshold: 0, timeoutMs: 8000, ...opts });
const mine = (hits) => (hits || []).filter((h) => String(h.uri || '').includes('p0-format-probe'));
const brief = (h) => ({
  uri: h.uri, score: Math.round(Number(h.score) * 1000) / 1000,
  abstract: String(h.abstract || '').slice(0, 260),
  overview_type: h.overview === null ? 'null' : typeof h.overview,
});

let cleaned = false;

async function cleanup(reason) {
  console.log(`\n[清理] 触发（${reason}）…`);
  const rm = await ovClient.remove(URI, { timeoutMs: 15000 }).catch((e) => ({ ok: false, error: { message: e.message } }));
  const back = await ovClient.readContent(URI, { timeoutMs: 5000 }).catch(() => ({ ok: true, text: '' }));
  // _probe 是探针专用临时目录（本脚本独占）：无论其中还有没有 OV 自动生成的伴随文件，一并清掉。
  const dirRm = await ovClient.remove(DIR, { recursive: true }).catch((e) => ({ ok: false, error: { message: e.message } }));
  const lsAfter = await ovClient.list(ROOT, { recursive: true }).catch(() => ({ ok: false, entries: [] }));
  const residue = lsAfter.ok
    ? lsAfter.entries.map((e) => e.uri).filter((u) => u.includes('/_probe'))
    : ['<资料根列举失败，无法确认>'];
  cleaned = !back.ok && residue.length === 0;
  const report = { rm_ok: !!rm.ok, readback_ok: !!back.ok, dir_rm_ok: !!dirRm.ok, residue };
  console.log(`  文件删除 ok=${!!rm.ok}；回读 file.ok=${!!back.ok}（应为 false）；目录清理 ok=${!!dirRm.ok}；残留=${JSON.stringify(residue)}`);
  console.log(cleaned ? '  ✓ 清理并复核通过：知识库中已无探针痕迹。' : '  ✗ 清理后仍有残留或无法确认——已如实记录，请人工处理。');
  return report;
}

async function finish(code, report) {
  out.cleanup = report || null;
  out.finished_at = new Date().toISOString();
  try { fs.writeFileSync(RESULT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8'); } catch { /* 结果文件写不出不影响结论 */ }
  console.log('\nP0_RESULT ' + JSON.stringify(out));
  process.exit(code);
}

// ── 0. 前置检查（全部只读） ─────────────────────────────────────────────
if (!(await ovClient.health())) {
  console.log('✗ OpenViking 不可用，探针中止（未写任何东西）。');
  await finish(1, null);
}
console.log(`endpoint = ${ovClient.config.endpoint}　auth=${ovClient.config.apiKey ? '有 Key' : '无 Key（dev）'}`);
console.log(`探针 URI = ${URI}`);
{
  const pre = await ovClient.readContent(URI, { timeoutMs: 5000 });
  if (pre.ok) { console.log('✗ 目标已存在同名文件（拒绝覆盖）。中止，未写任何东西。'); out.pre_existing = true; await finish(1, null); }
  const lsParent = await ovClient.list('viking://user/default/resources', { recursive: false }).catch(() => ({ ok: false, entries: [] }));
  out.parent_entries = lsParent.ok ? lsParent.entries.map((e) => e.uri) : ['<列举失败>'];
  console.log(`资源域现有顶层条目：${JSON.stringify(out.parent_entries)}`);
}

// ── 1. 写入（唯一一次写；wait:true 让服务端尽量同步刷新索引） ──────────────
{
  const t0 = Date.now();
  const w = await ovClient.write(URI, CONTENT, { wait: true, timeoutMs: 60000 });
  out.write = { ok: !!w.ok, status: w.status, took_ms: Date.now() - t0, error: w.ok ? '' : (w.error && w.error.message) || 'unknown' };
  console.log(`\n[1] write(wait:true) → ok=${w.ok} status=${w.status} 用时 ${out.write.took_ms}ms${w.ok ? '' : '　error=' + out.write.error}`);
  if (!w.ok) { console.log('✗ 写入失败：直接收尾（若有半写痕迹，清理会兜底）。'); const rep = await cleanup('write 失败'); await finish(1, rep); }
}

// ── 2. 等索引：轮询 4 个标记（FM/INTRO/S3/S5），全部命中或超时 ─────────────
{
  console.log('\n[2] 等待索引（每 2.5s 轮询一次，最长 90s）…');
  const t0 = Date.now();
  const deadline = t0 + 90000;
  let poll = 0;
  out.index = { index_wait_ms: -1, polls: 0 };
  for (;;) {
    poll += 1;
    const [hFM, hIn, h3, h5] = await Promise.all([findHits(FM), findHits(INTRO), findHits(S3), findHits(S5)]);
    const gotAll = [hFM, hIn, h3, h5].every((hs) => mine(hs).length > 0);
    console.log(`  轮询#${poll}：FM=${mine(hFM).length} INTRO=${mine(hIn).length} SEC3=${mine(h3).length} SEC5=${mine(h5).length}`);
    if (gotAll) { out.index.index_wait_ms = Date.now() - t0; out.index.polls = poll; break; }
    if (Date.now() >= deadline) { out.index.index_wait_ms = -1; out.index.polls = poll; out.index.partial = { FM: mine(hFM).length, INTRO: mine(hIn).length, SEC3: mine(h3).length, SEC5: mine(h5).length }; break; }
    await sleep(2500);
  }
  console.log(out.index.index_wait_ms >= 0 ? `  ✓ 索引可见，用时 ${out.index.index_wait_ms}ms（${out.index.polls} 轮）` : `  ⚠ 90s 内未全部可见：${JSON.stringify(out.index.partial)}`);
}

// ── 3. find 形状：各标记的命中（abstract 是否随段变化 → 切块粒度） ─────────
{
  out.find = {};
  for (const [name, q] of [['FM', FM], ['INTRO', INTRO], ['SEC1', S1], ['SEC2', S2], ['SEC2B', S2B], ['SEC3', S3], ['SEC4', S4], ['SEC5', S5], ['NOPE', NOPE]]) {
    const hits = await findHits(q);
    const list = mine(hits).map(brief);
    out.find[name] = list;
    console.log(`\n[3] find「${name}」→ 本文件命中 ${list.length} 条${name === 'NOPE' ? '（阴性对照，应为 0）' : ''}`);
    for (const h of list) console.log(`    score=${h.score} abstract=${JSON.stringify(h.abstract.slice(0, 160))}${h.abstract.length > 160 ? '…' : ''}`);
  }
}

// ── 4. 原始响应形状（走同一客户端/鉴权头，避免复刻漂移） ────────────────────
{
  const raw = await ovClient.fetchJSON('/api/v1/search/find', {
    method: 'POST', body: JSON.stringify({ query: S3, target_uri: ROOT, limit: 10, score_threshold: 0 })
  }, { timeoutMs: 15000 });
  const resources = raw.ok ? (raw.result && raw.result.resources) || [] : [];
  const entry = resources.find((e) => String(e && e.uri || '').includes('p0-format-probe')) || null;
  out.raw_entry_keys = entry ? Object.keys(entry) : [];
  out.raw_entry_preview = entry ? JSON.stringify(entry).slice(0, 1200) : '';
  out.raw_buckets = raw.ok && raw.result ? Object.keys(raw.result) : [];
  console.log(`\n[4] 原始响应：buckets=${JSON.stringify(out.raw_buckets)}　条目字段=${JSON.stringify(out.raw_entry_keys)}`);
  if (out.raw_entry_preview) console.log(`    raw=${out.raw_entry_preview}`);
}

// ── 5. readContent：全文 vs limit 30 vs offset 30 ─────────────────────────
{
  const full = await ovClient.readContent(URI, { timeoutMs: 10000 });
  const win3 = await ovClient.readContent(URI, { offset: 0, limit: 30, timeoutMs: 10000 });
  const win3b = await ovClient.readContent(URI, { offset: 30, limit: 30, timeoutMs: 10000 });
  const lines = (t) => String(t || '').split('\n');
  const findMarkers = (t) => [FM, INTRO, S1, S2, S2B, S3, S4, S5].filter((m) => String(t || '').includes(m));
  out.read = {
    full: { ok: full.ok, chars: full.text.length, lines: lines(full.text).length, markers: findMarkers(full.text) },
    win30: { ok: win3.ok, chars: win3.text.length, lines: lines(win3.text).length, markers: findMarkers(win3.text), has_frontmatter: /^---/.test(win3.text), text: win3.text },
    win60: { ok: win3b.ok, chars: win3b.text.length, lines: lines(win3b.text).length, markers: findMarkers(win3b.text), head: String(win3b.text || '').slice(0, 120) },
  };
  console.log(`\n[5] readContent 全文：ok=${full.ok} ${out.read.full.chars} 字 / ${out.read.full.lines} 行 / 标记覆盖 ${JSON.stringify(out.read.full.markers)}`);
  console.log(`    readContent(offset 0, limit 30)：ok=${win3.ok} ${out.read.win30.chars} 字 / ${out.read.win30.lines} 行 / 含 front matter 首行=${out.read.win30.has_frontmatter} / 标记覆盖 ${JSON.stringify(out.read.win30.markers)}`);
  console.log('    ── limit 30 实际取回（逐行）──');
  lines(win3.text).forEach((l, i) => console.log(`    ${String(i + 1).padStart(2)}| ${l}`));
  console.log(`    readContent(offset 30, limit 30)：ok=${win3b.ok} ${out.read.win60.chars} 字 / ${out.read.win60.lines} 行 / 头=${JSON.stringify(out.read.win60.head)}`);
}

// ── 6. 目录形状：OV 自动生成了什么（.abstract.md 等） ──────────────────────
{
  const lsDir = await ovClient.list(DIR, { recursive: true });
  const lsRoot = await ovClient.list(ROOT, { recursive: false });
  out.list = {
    dir_ok: lsDir.ok, dir_entries: lsDir.ok ? lsDir.entries.map((e) => e.uri) : [lsDir.error || '<失败>'],
    root_ok: lsRoot.ok, root_entries: lsRoot.ok ? lsRoot.entries.map((e) => e.uri) : [lsRoot.error || '<失败>'],
  };
  console.log(`\n[6] 目录列举 _probe（递归）：ok=${lsDir.ok}`);
  for (const u of out.list.dir_entries) console.log(`    - ${u}`);
  console.log(`    资料根顶层：ok=${lsRoot.ok}`);
  for (const u of out.list.root_entries) console.log(`    - ${u}`);
}

// ── 7. 删除 + 双重复核（readContent 应为 ok:false；find 不应再返回） ────────
{
  const rm = await ovClient.remove(URI, { timeoutMs: 15000 });
  const back = await ovClient.readContent(URI, { timeoutMs: 5000 });
  await sleep(3000);
  const findAfter = mine(await findHits(INTRO));
  out.delete = { rm_ok: !!rm.ok, readback_ok: !!back.ok, find_after_delete: findAfter.map(brief) };
  console.log(`\n[7] 删除：remove ok=${!!rm.ok}；回读 ok=${!!back.ok}（应为 false）；删除后 find 命中=${findAfter.length}（期望 0；非 0 = 索引有滞后）`);
}

// ── 8. 目录清理与最终复核 ─────────────────────────────────────────────────
{
  const rep = await cleanup('正常流程收尾');
  const cleanOk = cleaned;
  out.verdict = {
    cleanup_confirmed: cleanOk,
    frontmatter_vectorized: out.find && out.find.FM ? out.find.FM.length > 0 : null,
    chunking_observation: '见 find[SEC*] 的 abstract 对比：若不同段的 abstract 不同 → 段级切块；相同 → 文件级',
    window30_note: '见 read.win30：行数/字数/是否含 front matter',
  };
  console.log('\n[8] 结论摘要：');
  console.log(`    front matter 单独命中（${FM}）= ${out.verdict.frontmatter_vectorized} → ${out.verdict.frontmatter_vectorized ? 'front matter 参与索引' : 'front matter 未参与索引（或索引滞后）'}`);
  console.log(`    limit 30 取回：${out.read.win30.lines} 行 / ${out.read.win30.chars} 字（首行 front matter=${out.read.win30.has_frontmatter}）`);
  await finish(cleanOk ? 0 : 1, rep);
}
