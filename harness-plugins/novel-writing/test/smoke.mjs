/**
 * novel-writing 创作内核冒烟测试（纯 HTTP 断言，不依赖 dsh / 模型 / API Key）。
 *
 * 用法：node harness-plugins/novel-writing/test/smoke.mjs
 *
 * 覆盖：ping / 作品与章节 CRUD / 分层上下文 / 红线扫描（含对话豁免）/
 * 伏笔闭环与事件幂等 / 提案确认流 / 记忆版本与回滚与压缩提示 /
 * 一致性核对清单 / 正文写回（历史版本）/ 跨源写请求拒绝 / 非法红线拒绝。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

// 极简 ZIP 打包器（构造 EPUB 测试样本；stored=0 / deflate=8）。
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const comp = f.method === 8 ? deflateRawSync(f.data) : f.data;
    const nameB = Buffer.from(f.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(f.method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(f.method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, nameB, comp);
    central.push(ch, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

// 定位 novel-studio 仓库根：优先 NOVELSTUDIO_REPO 环境变量，
// 否则从本文件向上找 package.json（name === 'novel-studio'），
// 使本脚本在「工坊仓库内 harness-plugins/novel-writing/test/」与
// 「发布镜像仓库根 test/」两种位置都能直接运行。
function findStudioRoot() {
  if (process.env.NOVELSTUDIO_REPO) return process.env.NOVELSTUDIO_REPO;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'novel-studio') return dir;
      } catch (_) { /* 继续向上 */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 novel-studio 仓库：请用 NOVELSTUDIO_REPO 环境变量指定其根目录');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findStudioRoot();
// zip 读取器在 novel-studio 仓库根（发布镜像仓库不含服务端文件），按定位到的仓库根动态加载。
const { readZip } = await import(pathToFileURL(join(repoRoot, 'zip-reader.mjs')).href);
const PORT = 3900 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'novel-smoke-'));

let passed = 0;
function ok(label) { passed += 1; console.log(`  ✔ ${label}`); }
function stripHtml(html = '') {
  return String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
async function jfetch(path, options = {}) {
  const res = await fetch(BASE + path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await jfetch('/api/novel/ping');
      if (r.status === 200) return;
    } catch (_) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('服务未在超时内就绪\n' + serverLog.slice(-2000));
}

try {
  await waitForServer();
  console.log(`novel-writing 冒烟测试（服务端口 ${PORT}）`);

  // 1. ping
  {
    const r = await jfetch('/api/novel/ping');
    assert.equal(r.status, 200);
    assert.equal(r.data.service, 'novel-studio');
    ok('ping 探活');
  }

  // 2. 基础数据：作品 + 章节
  let workId, chapterId;
  {
    const r = await jfetch('/api/works', { method: 'POST', body: { title: '冒烟测试作品', description: '测试用' } });
    assert.equal(r.status, 201);
    workId = r.data.id;
    assert.ok(workId > 0);
    const c = await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第一章' } });
    assert.equal(c.status, 201);
    chapterId = c.data.id;
    ok('创建作品与章节');
  }

  // 3. 分层上下文
  {
    const r = await jfetch(`/api/novel/context?work_id=${workId}&chapter_id=${chapterId}&mode=continuation`);
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.ok(r.data.assembled.includes('【写作风格红线】'), '红线层必须在装配结果里');
    assert.ok(r.data.assembled.includes('未闭合伏笔'), '未闭合伏笔层必须在装配结果里');
    assert.ok(Array.isArray(r.data.open_foreshadows));
    assert.equal(r.data.needs_compression, false);
    ok('分层上下文（含伏笔层与红线保底）');
  }

  // 4. 红线扫描 + 对话豁免
  {
    const dirty = '他嘴角勾起一抹冷笑，眼中闪过一丝复杂，不禁浑身一震。';
    const r1 = await jfetch('/api/novel/scan', { method: 'POST', body: { work_id: workId, text: dirty } });
    assert.equal(r1.status, 200);
    assert.ok(r1.data.total > 0, 'AI 腔文本应命中红线');
    const dialog = '“你嘴角勾起的弧度出卖了你。”她淡淡道。';
    const r2 = await jfetch('/api/novel/scan', { method: 'POST', body: { work_id: workId, text: dialog, skip_dialogue: true } });
    assert.equal(r2.status, 200);
    const r3 = await jfetch('/api/novel/scan', { method: 'POST', body: { work_id: workId, text: dialog } });
    assert.ok(r3.data.total > 0, '含对话的原文应命中');
    assert.ok((r2.data.total ?? Infinity) < r3.data.total, '跳过对话后命中数应减少');
    ok('红线扫描（命中 + skip_dialogue 豁免）');
  }

  // 5. 伏笔闭环 + 幂等去重
  let foreshadowId;
  {
    const f = await jfetch('/api/novel/events', {
      method: 'POST',
      body: { work_id: workId, chapter_id: chapterId, kind: 'foreshadow', summary: '柜子第三层藏着一把钥匙', dedup_key: 'smoke-fs-1' }
    });
    assert.equal(f.status, 201);
    foreshadowId = f.data.id;
    const list = await jfetch(`/api/novel/foreshadows?work_id=${workId}&status=open`);
    assert.ok(list.data.foreshadows.some((x) => x.id === foreshadowId));
    const ev = await jfetch('/api/novel/events', {
      method: 'POST',
      body: { work_id: workId, chapter_id: chapterId, kind: 'event', summary: '主角打开柜子拿到了钥匙', resolves_event_id: foreshadowId, dedup_key: 'smoke-ev-1' }
    });
    assert.equal(ev.status, 201);
    const list2 = await jfetch(`/api/novel/foreshadows?work_id=${workId}&status=open`);
    assert.ok(!list2.data.foreshadows.some((x) => x.id === foreshadowId), '被回收的伏笔不应再是未闭合');
    const again = await jfetch('/api/novel/events', {
      method: 'POST',
      body: { work_id: workId, chapter_id: chapterId, kind: 'event', summary: '主角打开柜子拿到了钥匙', resolves_event_id: foreshadowId, dedup_key: 'smoke-ev-1' }
    });
    assert.equal(again.data.duplicate, true, '同一 dedup_key 重复提交应幂等');
    ok('伏笔闭环（open → resolved）与事件幂等');
  }

  // 6. 提案确认流
  {
    const p1 = await jfetch('/api/novel/events', {
      method: 'POST',
      body: { work_id: workId, kind: 'event', summary: 'AI 提案：主角受伤', proposed: true }
    });
    assert.equal(p1.status, 201);
    assert.ok(p1.data.proposed && p1.data.proposal_id > 0);
    const p2 = await jfetch('/api/story_memory', {
      method: 'PUT',
      body: { work_id: workId, summary: 'AI 提案：记忆草稿', proposed: true }
    });
    assert.ok(p2.data.proposed && p2.data.proposal_id > 0);
    const before = await jfetch(`/api/novel/events?work_id=${workId}`);
    assert.ok(!before.data.events.some((e) => e.summary === 'AI 提案：主角受伤'), '提案未采纳前不得入账');
    const list = await jfetch(`/api/novel/proposals?work_id=${workId}`);
    assert.equal(list.data.proposals.length, 2);
    const apply = await jfetch('/api/novel/proposals/apply', {
      method: 'POST',
      body: { work_id: workId, ids: list.data.proposals.map((p) => p.id) }
    });
    assert.equal(apply.data.applied.events, 1);
    assert.equal(apply.data.applied.memories, 1);
    const after = await jfetch(`/api/novel/events?work_id=${workId}`);
    assert.ok(after.data.events.some((e) => e.summary === 'AI 提案：主角受伤'), '采纳后应入账');
    const mem = await jfetch(`/api/story_memory?work_id=${workId}`);
    assert.equal(mem.data.summary, 'AI 提案：记忆草稿');
    ok('提案确认流（pending → apply → 入账）');
  }

  // 7. 记忆版本 / 回滚 / 压缩提示
  {
    const v1 = await jfetch('/api/story_memory', { method: 'PUT', body: { work_id: workId, summary: '记忆版本一' } });
    assert.ok(v1.data.version_id > 0);
    const long = '很长的记忆。'.repeat(201); // 1206 字 > 1200 压缩提示线
    const v2 = await jfetch('/api/story_memory', { method: 'PUT', body: { work_id: workId, summary: long } });
    assert.equal(v2.data.needs_compression, true, '超长记忆应标记压缩提示');
    const versions = await jfetch(`/api/story_memory/versions?work_id=${workId}`);
    assert.ok(versions.data.versions.length >= 2);
    const rb = await jfetch('/api/story_memory/rollback', { method: 'POST', body: { version_id: v1.data.version_id } });
    assert.equal(rb.data.summary, '记忆版本一');
    const mem = await jfetch(`/api/story_memory?work_id=${workId}`);
    assert.equal(mem.data.summary, '记忆版本一');
    ok('记忆版本快照 / 压缩提示 / 回滚');
  }

  // 8. 一致性核对清单
  {
    const r = await jfetch('/api/novel/consistency', {
      method: 'POST',
      body: { work_id: workId, chapter_id: chapterId, text: '主角拿到了钥匙。' }
    });
    assert.equal(r.status, 200);
    const c = r.data.checklist;
    assert.ok(Array.isArray(c.open_foreshadows) && Array.isArray(c.present_characters) && Array.isArray(c.recent_events));
    assert.ok(typeof c.style_scan.total === 'number');
    ok('一致性核对清单装配');
  }

  // 8b. 作品写作配置（每章目标字数/总章数/结构/视角）
  {
    const up = await jfetch(`/api/works/${workId}`, {
      method: 'PUT',
      body: { default_chapter_words: 3000, total_chapters: 36, story_structure: '三幕结构', narrative_pov: '第三人称有限视角' }
    });
    assert.equal(up.data.default_chapter_words, 3000);
    assert.equal(up.data.total_chapters, 36);
    assert.equal(up.data.story_structure, '三幕结构');
    const ctx = await jfetch(`/api/novel/context?work_id=${workId}&chapter_id=${chapterId}`);
    assert.ok(ctx.data.assembled.includes('每章目标字数：3000 字'), '上下文应携带目标字数');
    assert.ok(ctx.data.assembled.includes('三幕结构'), '上下文应携带故事结构');
    ok('作品写作配置（字数/总章数/结构/视角）');
  }

  // 8c. 章节蓝图：保存 → 上下文带入 → 空蓝图拒绝
  {
    const bp = {
      scene_goal: '主角在档案室找到钥匙的下落',
      plot_points: '1. 潜入档案室\n2. 与守夜人周旋\n3. 发现钥匙指向城南钟楼',
      conflicts: '守夜人认出主角',
      character_changes: '主角：右手受伤',
      hook: '钟楼里传来第十四声钟响',
      references: '柜子第三层的钥匙'
    };
    const saved = await jfetch('/api/novel/chapter_blueprint', {
      method: 'PUT',
      body: { chapter_id: chapterId, blueprint: bp, target_words: 3200 }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.target_words, 3200);
    const ctx = await jfetch(`/api/novel/context?work_id=${workId}&chapter_id=${chapterId}`);
    assert.ok(ctx.data.assembled.includes('本章蓝图（写作必须遵守）'), '上下文应包含蓝图层');
    assert.ok(ctx.data.assembled.includes('潜入档案室'), '蓝图内容应进入上下文');
    assert.ok(ctx.data.assembled.includes('每章目标字数：3200 字'), '章节级目标字数应覆盖作品默认');
    const empty = await jfetch('/api/novel/chapter_blueprint', {
      method: 'PUT',
      body: { chapter_id: chapterId, blueprint: { scene_goal: '' } }
    });
    assert.equal(empty.status, 400, '空蓝图应被拒绝');
    ok('章节蓝图（保存/上下文带入/章节级字数覆盖/空蓝图拒绝）');
  }

  // 8d. 多关键词检索：AND 匹配 + 分组 + 排序
  {
    const term = await jfetch('/api/terms', {
      method: 'POST',
      body: { work_id: workId, title: '雾城档案管理局', content: '负责城市记忆存档与修复的机构，档案室位于旧城区。' }
    });
    assert.ok(term.data.id > 0);
    const ch2 = await jfetch('/api/chapters', {
      method: 'POST',
      body: { work_id: workId, title: '档案室之夜', summary: '主角夜探档案室寻找钥匙。' }
    });
    const r1 = await jfetch(`/api/search?q=${encodeURIComponent('档案')}&work_id=${workId}`);
    assert.ok(r1.data.terms.some((t) => t.title === '雾城档案管理局'), '词条标题命中');
    assert.ok(r1.data.chapters.some((c) => c.title === '档案室之夜'), '章节标题命中');
    const r2 = await jfetch(`/api/search?q=${encodeURIComponent('档案 钥匙')}&work_id=${workId}`);
    assert.ok(r2.data.chapters.some((c) => c.id === ch2.data.id), '多关键词 AND 应命中同时含两词的章节');
    const r3 = await jfetch(`/api/search?q=${encodeURIComponent('不存在的词xyz')}&work_id=${workId}`);
    assert.equal(r3.data.terms.length + r3.data.chapters.length + r3.data.characters.length + r3.data.plotlines.length, 0);
    ok('多关键词检索（AND/分组/空结果）');
  }

  // 8e. 章节审稿：保存报告 → 读取 → 确认清单 → 空报告拒绝
  {
    const saved = await jfetch('/api/novel/review', {
      method: 'PUT',
      body: {
        chapter_id: chapterId,
        report: { summary: '节奏尚可，中段冲突略弱。', issues: ['中段冲突铺垫不足', '开头两句 AI 腔'], strengths: ['钩子有力'] }
      }
    });
    assert.equal(saved.status, 201);
    assert.ok(saved.data.review_id > 0);
    const got = await jfetch(`/api/novel/review?chapter_id=${chapterId}`);
    assert.equal(got.data.review.report.issues.length, 2);
    const ck = await jfetch('/api/novel/review/checklist', {
      method: 'PUT',
      body: { review_id: saved.data.review_id, checklist: { 0: 'confirmed', 1: 'ignored' } }
    });
    assert.equal(ck.data.ok, true);
    const got2 = await jfetch(`/api/novel/review?chapter_id=${chapterId}`);
    assert.equal(got2.data.review.status, 'confirmed');
    assert.equal(got2.data.review.checklist['1'], 'ignored');
    const emptyReport = await jfetch('/api/novel/review', {
      method: 'PUT',
      body: { chapter_id: chapterId, report: { summary: '', issues: [] } }
    });
    assert.equal(emptyReport.status, 400, '空审稿报告应被拒绝');
    ok('章节审稿（保存/读取/确认清单/空报告拒绝）');
  }

  // 8f. 伏笔状态流转（面板操作对应的端点）
  {
    const f = await jfetch('/api/novel/events', {
      method: 'POST',
      body: { work_id: workId, kind: 'foreshadow', summary: '钟楼第十四声钟响' }
    });
    const fid = f.data.id;
    const st1 = await jfetch(`/api/novel/foreshadows/${fid}/status`, { method: 'POST', body: { status: 'resolved' } });
    assert.equal(st1.data.foreshadow_status, 'resolved');
    const open = await jfetch(`/api/novel/foreshadows?work_id=${workId}&status=open`);
    assert.ok(!open.data.foreshadows.some((x) => x.id === fid), '已回收不应出现在未闭合列表');
    const st2 = await jfetch(`/api/novel/foreshadows/${fid}/status`, { method: 'POST', body: { status: 'open' } });
    assert.equal(st2.data.foreshadow_status, 'open');
    const bad = await jfetch(`/api/novel/foreshadows/${fid}/status`, { method: 'POST', body: { status: 'whatever' } });
    assert.equal(bad.status, 400, '非法状态应被拒绝');
    ok('伏笔状态流转（resolved/open/非法拒绝）');
  }

  // 8g. 空章节查询（批量生成选章依据）
  {
    const empty1 = await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '待生成一' } });
    const empty2 = await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '待生成二' } });
    const list = await jfetch(`/api/novel/empty_chapters?work_id=${workId}`);
    assert.ok(list.data.chapters.some((c) => c.id === empty1.data.id));
    assert.ok(list.data.chapters.some((c) => c.id === empty2.data.id));
    // 写回空章节一，再查应消失
    await jfetch('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: empty1.data.id, content: '<p>有内容了</p>' } });
    const list2 = await jfetch(`/api/novel/empty_chapters?work_id=${workId}`);
    assert.ok(!list2.data.chapters.some((c) => c.id === empty1.data.id), '写入正文后应从空章节列表消失');
    assert.ok(list2.data.chapters.some((c) => c.id === empty2.data.id));
    ok('空章节查询（批量生成选章依据）');
  }

  // 8h. 导入拆章（TXT 文本）+ 导出 TXT/MD/单章
  {
    const text = '楔子\n一切的开始。\n\n第一章 初入雾城\n主角抵达雾城。\n\n第二章 档案室\n夜探档案室。\n\n第三章 钟声\n第十四声钟响。';
    const imp = await jfetch('/api/import', { method: 'POST', body: { title: '导入测试书', text } });
    assert.equal(imp.status, 201);
    assert.equal(imp.data.chapters, 4, '应按章节标题拆成 4 章');
    const newWorkId = imp.data.work_id;
    const chs = await jfetch(`/api/chapters?work_id=${newWorkId}`);
    assert.equal(chs.data.length, 4);
    assert.equal(chs.data[0].title, '楔子');
    const txt = await jfetch(`/api/export/txt?work_id=${newWorkId}`);
    assert.equal(txt.status, 200);
    const txtRaw = txt.data.raw || '';
    assert.ok(txtRaw.includes('第一章 初入雾城'));
    assert.ok(txtRaw.includes('第十四声钟响'));
    assert.match(txt.headers.get('content-disposition') || '', /attachment/);
    const md = await jfetch(`/api/export/md?work_id=${newWorkId}`);
    const mdRaw = md.data.raw || '';
    assert.ok(mdRaw.includes('# 导入测试书'));
    assert.ok(mdRaw.includes('### 第一章 初入雾城'));
    const single = await jfetch(`/api/export/txt?chapter_id=${chs.data[1].id}`);
    const singleRaw = single.data.raw || '';
    assert.ok(singleRaw.includes('主角抵达雾城'));
    assert.ok(!singleRaw.includes('第二章'), '单章导出不应包含其它章');
    ok('导入拆章（TXT）+ 导出（整书 TXT/MD、单章 TXT）');
  }

  // 8i. EPUB 导入（零依赖 zip 读取 + spine 拆章）
  {
    const opf = `<?xml version="1.0"?><package><metadata><dc:title>雾城 EPUB</dc:title></metadata>
      <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const epub = makeZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip'), method: 0 },
      { name: 'META-INF/container.xml', data: Buffer.from(container), method: 8 },
      { name: 'OEBPS/content.opf', data: Buffer.from(opf), method: 8 },
      { name: 'OEBPS/ch1.xhtml', data: Buffer.from('<html><body><h1>第一章</h1><p>雾城第一段。</p><p>第二段。</p></body></html>'), method: 8 },
      { name: 'OEBPS/ch2.xhtml', data: Buffer.from('<html><body><h2>第二章</h2><p>钟声响了。</p></body></html>'), method: 8 }
    ]);
    // 直接单测 zip 读取器（stored + deflate 混用）
    const entries = readZip(epub);
    assert.equal(entries.get('mimetype').toString(), 'application/epub+zip');
    assert.ok(entries.get('OEBPS/ch2.xhtml').toString().includes('钟声响了'));
    const imp = await jfetch('/api/import', { method: 'POST', body: { title: '', base64: epub.toString('base64') } });
    assert.equal(imp.status, 201);
    assert.equal(imp.data.title, '雾城 EPUB', '标题应取自 EPUB 元数据');
    assert.equal(imp.data.chapters, 2);
    const chs = await jfetch(`/api/chapters?work_id=${imp.data.work_id}`);
    assert.equal(chs.data[0].title, '第一章');
    assert.ok(stripHtml(chs.data[0].content).includes('雾城第一段'));
    const bad = await jfetch('/api/import', { method: 'POST', body: { base64: Buffer.from('not a zip').toString('base64') } });
    assert.equal(bad.status, 400, '非 ZIP 内容应被拒绝');
    ok('EPUB 导入（zip 读取/spine 拆章/标题提取/坏文件拒绝）');
  }

  // 9. 正文写回（旧稿历史版本 + 扫描返回）
  {
    const first = await jfetch('/api/novel/chapter_save', {
      method: 'POST', body: { work_id: workId, chapter_id: chapterId, content: '<p>第一稿</p>', summary: '初稿摘要' }
    });
    assert.equal(first.status, 200);
    assert.ok(first.data.version_id > 0);
    const second = await jfetch('/api/novel/chapter_save', {
      method: 'POST', body: { work_id: workId, chapter_id: chapterId, content: '<p>第二稿，他嘴角勾起一抹冷笑。</p>' }
    });
    assert.ok(second.data.version_id > 0);
    assert.ok(second.data.scan.total > 0, '写回响应应带红线扫描');
    const ch = await jfetch(`/api/chapters/${chapterId}`);
    assert.equal(ch.data.summary, '初稿摘要', '未传 summary 时应保持原摘要');
    assert.ok(ch.data.content.includes('第二稿'));
    ok('正文写回（历史版本 + 扫描返回 + 字段保持）');
  }

  // 10. 安全：跨源写请求拒绝、无 CORS 通配
  {
    const evil = await jfetch('/api/novel/events', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: { work_id: workId, kind: 'event', summary: '恶意写入' }
    });
    assert.equal(evil.status, 403);
    const works = await jfetch('/api/works');
    assert.equal(works.headers.get('access-control-allow-origin'), null, '不得返回 CORS 通配头');
    const bad = await jfetch('/api/novel/redlines', {
      method: 'PUT',
      body: { work_id: null, entries: [{ kind: 'regex', pattern: '(unclosed' }] }
    });
    assert.equal(bad.status, 400, '非法正则红线应被拒绝');
    ok('跨源写拒绝 / 无 CORS 通配 / 非法红线拒绝');
  }

  console.log(`\n✅ 全部 ${passed} 组断言通过。`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n❌ 冒烟测试失败：', e.message);
  console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  setTimeout(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* 忽略清理失败 */ }
  }, 400);
}
