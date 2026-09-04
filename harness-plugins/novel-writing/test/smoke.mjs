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
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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
const PORT = 3900 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'novel-smoke-'));

let passed = 0;
function ok(label) { passed += 1; console.log(`  ✔ ${label}`); }
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
