#!/usr/bin/env node
/**
 * library 层的「未开启即不存在」字节级验证（P1 验收工具）。
 *
 * 方法：隔离实例（临时数据目录 + 关闭 OV 与自动索引，保证确定性）里建一套固定夹具，
 * 抓取 /api/novel/context 的 assembled / context_manifest / context_envelope 到 JSON。
 * 在改动前后各跑一次：
 *   node .p1-baseline/verify-library-identity.mjs --capture .p1-baseline/library-identity-before.json
 *   node .p1-baseline/verify-library-identity.mjs --compare .p1-baseline/library-identity-before.json
 * compare 模式逐字节对照；不一致时打印第一处差异。
 *
 * 为什么关 OV：召回内容依赖活索引，波动会掩盖真正的结构变化；本工具只证明
 * 「未开启 library 的作品，装配结果与改动前逐字节一致」——OFF 档的行为等价性。
 * 开启后的行为由 test-library-live.mjs（真机）覆盖。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const mode = process.argv.includes('--compare') ? 'compare' : 'capture';
const fileArg = process.argv[process.argv.indexOf(mode === 'compare' ? '--compare' : '--capture') + 1];
if (!fileArg) { console.error('用法: --capture <file> | --compare <file>'); process.exit(2); }
const FILE = resolve(REPO, fileArg);

const PORT = await new Promise((r) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => r(5700 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => r(p)); });
  }).catch(() => r(5700 + (process.pid % 300)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-lib-identity-'));

async function jfetch(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NOVELSTUDIO_DATA_DIR: DATA_DIR,
    NOVELSTUDIO_OV_DISABLED: '1',
    NOVELSTUDIO_OV_AUTOINDEX: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });
const cleanup = () => {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 文件锁：留给临时目录清理 */ }
};

let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { ready = (await jfetch('/api/novel/ping')).status === 200; } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('隔离实例未就绪\n' + log.slice(-2000)); cleanup(); process.exit(2); }

// 固定夹具：2 部作品 × 2 章（id 由全新库自增，稳定可复现）
const w1 = (await jfetch('/api/works', { method: 'POST', body: { title: '资料位基线·甲' } })).data.id;
const w2 = (await jfetch('/api/works', { method: 'POST', body: { title: '资料位基线·乙' } })).data.id;
const ch = {};
ch.a1 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: w1, title: '第一章 起' } })).data.id;
ch.a2 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: w1, title: '第二章 承' } })).data.id;
ch.b1 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: w2, title: '第一章 转' } })).data.id;

const captureOne = async (workId, chapterId, modeName) => {
  const r = await jfetch(`/api/novel/context?work_id=${workId}&chapter_id=${chapterId}&mode=${modeName}`);
  const d = r.data || {};
  return {
    assembled: String(d.assembled || ''),
    context_id: d.context_id || '',
    manifest: d.context_manifest || [],
    selected: (d.context_envelope && d.context_envelope.selected) || [],
    excluded: (d.context_envelope && d.context_envelope.excluded) || [],
    stats: d.context_stats || {},
    overflow: d.context_overflow ?? null,
    semantic_recall: {
      enabled: (d.semantic_recall && d.semantic_recall.enabled) || false,
      status: (d.semantic_recall && d.semantic_recall.status) || '',
    },
  };
};

const snap = {
  cases: {
    'a1-full': await captureOne(w1, ch.a1, 'full'),
    'a2-full': await captureOne(w1, ch.a2, 'full'),
    'a1-settings': await captureOne(w1, ch.a1, 'settings'),
    'b1-full': await captureOne(w2, ch.b1, 'full'),
  },
};

const stable = (v) => JSON.stringify(v, (k, val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) return Object.fromEntries(Object.keys(val).sort().map((key) => [key, val[key]]));
  return val;
});

let fail = 0;
if (mode === 'capture') {
  writeFileSync(FILE, JSON.stringify(snap, null, 2) + '\n', 'utf8');
  console.log(`已抓取基线：${FILE}`);
  console.log(`夹具：w1=${w1}(ch ${ch.a1}/${ch.a2}) w2=${w2}(ch ${ch.b1})`);
  for (const [name, c] of Object.entries(snap.cases)) {
    console.log(`  ${name}: assembled ${c.assembled.length} 字 / manifest ${c.manifest.length} 层 / context_id ${c.context_id}`);
  }
} else {
  const before = JSON.parse(readFileSync(FILE, 'utf8'));
  for (const name of Object.keys(before.cases)) {
    const a = before.cases[name]; const b = snap.cases[name];
    if (stable(a) === stable(b)) { console.log(`  ✓ ${name} 逐字节一致（assembled ${b.assembled.length} 字 / manifest ${b.manifest.length} 层）`); continue; }
    fail += 1;
    console.log(`  ✗ ${name} 不一致`);
    if (a.assembled !== b.assembled) {
      let i = 0; while (i < Math.min(a.assembled.length, b.assembled.length) && a.assembled[i] === b.assembled[i]) i += 1;
      console.log(`    assembled 首处差异 @${i}: before=${JSON.stringify(a.assembled.slice(i, i + 60))} after=${JSON.stringify(b.assembled.slice(i, i + 60))}`);
    }
    for (const key of ['manifest', 'selected', 'excluded', 'stats', 'context_id', 'overflow']) {
      if (stable(a[key]) !== stable(b[key])) console.log(`    ${key} 不同`);
    }
  }
  console.log(fail ? `\n✗ 未开启 library 的作品装配结果发生变化（${fail} 例）` : '\n✓ 全部用例逐字节一致');
}

cleanup();
process.exit(fail ? 1 : 0);
