/**
 * tests/nsdsh/module-boundaries.test.mjs —— 模块边界的**结构断言**（S03，零依赖、零计费）。
 *
 * S03 的验收项之一是：**单元测试 import 领域模块不会启动服务、也不会调用模型。**
 * 这条不能靠"我们小心"来保证，必须是结构事实，所以这里用三组断言把它钉住：
 *
 *   ① 【静态】`server/services/temporal-services.mjs` 的 import 图里**不得**出现
 *     `server.js` / `db.js` / 任何 HTTP 或网络模块；它只允许 import node 内置或什么都不 import。
 *   ② 【动态】在一个**干净的子进程**里 import 该模块，然后断言：
 *     · 进程没有因为 import 而挂住（有计时上限）；
 *     · 没有监听任何端口（检查 `process._getActiveHandles()` 里没有 Server）；
 *     · 没有打开过数据库文件（`NOVELSTUDIO_DATA_DIR` 指向的目录在 import 后仍为空）。
 *   ③ 【动态】用假 deps 调四个用例函数，断言它们**不发网络请求**、只与注入的 deps 交互
 *     （假 deps 记录调用次数；同时断言全局 fetch 未被调用）。
 *
 * 为什么坚持"子进程 + 真计时"而不是同进程断言：同进程里 `server.js` 早就被别的测试
 * import 过了，副作用已经被吃掉，再断言"没有副作用"就是假绿。子进程才是干净的观测点。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../scripts/nsdsh/lib/gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SVC_REL = 'server/services/temporal-services.mjs';

function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') throw new Error('异步用例必须放进 suiteAsync()');
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

const readSvc = () => fs.readFileSync(path.join(REPO, SVC_REL), 'utf8');

suite('nsdsh/module-boundaries', [
  // ── ① 静态：import 图里不得有服务/数据库/网络 ────────────────────────────────
  ['[静态] 服务模块不 import server.js / db.js / HTTP / 网络模块', () => {
    const src = readSvc();
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const forbidden = imports.filter((s) => /(^|\/)(server\.js|db\.js)$/.test(s)
      || /node:(http|https|net|dgram|tls)$/.test(s)
      || /^(http|https|net|dgram|tls)$/.test(s));
    assert.deepEqual(forbidden, [], `服务模块不得 import 这些：${forbidden.join(', ')}`);
    // 允许的只有 node 内置（当前实现一个都不需要，但不断言"必须为空"以免过度约束）。
    for (const s of imports) {
      assert.ok(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../'),
        `意外依赖：${s}`);
    }
  }],

  ['[静态] 服务模块不 import 时执行副作用（顶层不得有 new Server / listen / open / connect）', () => {
    const src = readSvc();
    assert.ok(!/createServer\s*\(/.test(src), '服务模块不得建 HTTP server');
    assert.ok(!/\.listen\s*\(/.test(src), '服务模块不得 listen');
    assert.ok(!/new\s+DatabaseSync\s*\(/.test(src), '服务模块不得自己打开数据库');
    assert.ok(!/from\s+['"]\.\.\/\.\.\/db\.js['"]/.test(src), '服务模块不得直接 import db.js');
    // 也不得在顶层 await 网络（顶层 await 会给"import 即产生副作用"留口子）。
    assert.ok(!/^\s*await\s/m.test(src), '服务模块不得有顶层 await');
  }],

  ['[静态] 接触数据库的唯一入口是 makeTemporalDeps（依赖注入）', () => {
    const src = readSvc();
    assert.match(src, /export function makeTemporalDeps\(\{ prepare, temporal \}\)/);
    // `prepare(` 只应出现在注入的 deps 构造里，不应存在模块级自己创建的语句。
    const prepareCalls = (src.match(/prepare\(/g) || []).length;
    assert.ok(prepareCalls >= 1, 'makeTemporalDeps 必须用注入的 prepare');
    assert.ok(!/const\s+prepare\s*=/.test(src), '不得在模块里自建 prepare');
  }],

  // ── ② 动态：干净子进程里 import，观察是否启动服务 / 打开数据库 ────────────────
  ['[动态] 干净子进程 import 服务模块：不监听端口、不打开数据库、不挂住', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsdsh-boundary-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // 子进程脚本：import 服务模块 → 检查活动句柄里有没有 Server → 检查数据目录是否仍为空。
    const probe = `
import fs from 'node:fs';
const t0 = Date.now();
const mod = await import(${JSON.stringify('file:///' + path.join(REPO, SVC_REL).replace(/\\/g, '/'))});
const ms = Date.now() - t0;
const handles = (process._getActiveHandles ? process._getActiveHandles() : [])
  .map((h) => h && h.constructor && h.constructor.name).filter(Boolean);
const servers = handles.filter((n) => /Server/.test(n));
const sockets = handles.filter((n) => /Socket/.test(n));
const files = fs.readdirSync(${JSON.stringify(dataDir)});
console.log(JSON.stringify({ ms, servers, sockets, files, exports: Object.keys(mod).sort() }));
process.exit(0);
`;
    const r = runCommand([process.execPath, '--input-type=module', '-e', probe], {
      cwd: REPO,
      timeoutMs: 60000,
      env: { NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1' },
    });
    try {
      assert.equal(r.status, 0, `探针子进程必须正常退出：exit=${r.status} ${(r.stderr || '').slice(0, 300)}`);
      const out = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
      assert.deepEqual(out.servers, [], `import 服务模块不得让进程开始监听端口，实际 ${out.servers.join(',')}`);
      assert.deepEqual(out.sockets, [], `import 服务模块不得建立 socket，实际 ${out.sockets.join(',')}`);
      assert.deepEqual(out.files, [], `import 服务模块不得打开/写入数据目录，实际 ${out.files.join(',')}`);
      assert.ok(out.ms < 30000, `import 必须当场返回（不挂住），实际 ${out.ms}ms`);
      for (const name of ['confirmEvents', 'confirmProposalGroup', 'analyzeChapterUseCase', 'queryStoryState', 'makeTemporalDeps']) {
        assert.ok(out.exports.includes(name), `必须导出 ${name}，实际导出 ${out.exports.join(',')}`);
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清理失败不掩盖断言 */ }
    }
  }],
]);

/** 异步用例版（`import()` 是异步的）；语义与 `suite` 相同。 */
async function suiteAsync(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

await suiteAsync('nsdsh/module-boundaries（异步：动态 import）', [
  // ── ③ 动态：用例函数只与注入的 deps 交互，不发网络 ────────────────────────────
  ['[动态] 四个用例只通过注入的 deps 工作；全程不调用 fetch', async () => {
    const { confirmEvents, confirmProposalGroup, analyzeChapterUseCase, queryStoryState } = await import('../../server/services/temporal-services.mjs');
    const calls = { workExists: 0, getChapter: 0, apply: 0, confirm: 0 };
    const deps = {
      prepare: () => ({ get: () => null }),
      workExists: () => { calls.workExists += 1; return true; },
      getChapter: (id) => { calls.getChapter += 1; return { id, work_id: 1, title: 't', summary: '', content: 'x' }; },
      temporal: {
        applyChapterEvents: (a) => { calls.apply += 1; return { ok: true, decision: 'valid', echo: a.workId }; },
        confirmBinding: (a) => { calls.confirm += 1; return { ok: true, decision: 'valid', echo: a.bindingId }; },
      },
    };
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (...a) => { fetchCalls += 1; return origFetch(...a); };
    try {
      const c1 = confirmEvents(deps, { workId: 1, chapterId: 7, events: [{ ops: [] }] });
      assert.equal(c1.ok, true);
      assert.equal(c1.result.echo, 1);
      const c2 = confirmProposalGroup(deps, { workId: 1, chapterId: 7, bindingId: 'b1' });
      assert.equal(c2.ok, true);
      assert.equal(c2.result.echo, 'b1');
      const c3 = analyzeChapterUseCase(deps, { workId: 1, chapterId: 7 });
      assert.equal(c3.ok, true);
      const c4 = queryStoryState(deps, { workId: 1, chapterId: 7 });
      assert.equal(c4.ok, true);
      assert.equal(calls.apply, 1, 'confirmEvents 必须恰好调一次内核');
      assert.equal(calls.confirm, 1, 'confirmProposalGroup 必须恰好调一次内核');
      assert.equal(fetchCalls, 0, '用例层不得发任何网络请求');
    } finally {
      globalThis.fetch = origFetch;
    }
  }],

  ['[动态] 用例层把"缺参/越权"裁决为结构化失败，且**不**触碰内核', async () => {
    const { confirmEvents, queryStoryState, resolveChapterScope } = await import('../../server/services/temporal-services.mjs');
    let kernelCalls = 0;
    const deps = {
      prepare: () => ({ get: () => null }),
      workExists: () => true,
      getChapter: () => ({ id: 7, work_id: 1 }),
      temporal: { applyChapterEvents: () => { kernelCalls += 1; return { ok: true }; }, confirmBinding: () => { kernelCalls += 1; return { ok: true }; } },
    };
    // 模型通道：403，且不得触发内核
    const model = confirmEvents(deps, { workId: 1, chapterId: 7, events: [{ ops: [] }], modelRequest: true });
    assert.equal(model.ok, false);
    assert.equal(model.status, 403);
    // 缺 work_id：400
    const noWork = queryStoryState(deps, {});
    assert.equal(noWork.status, 400);
    // 缺 events：400
    const noEvents = confirmEvents(deps, { workId: 1, chapterId: 7, events: [] });
    assert.equal(noEvents.status, 400);
    assert.match(noEvents.message, /events 不能为空/);
    // 章节不属于该作品：404
    const crossWork = resolveChapterScope({ workExists: () => true, getChapter: () => ({ id: 7, work_id: 2 }), prepare: () => ({ get: () => null }) }, { workId: 1, chapterId: 7 });
    assert.equal(crossWork.status, 404);
    assert.equal(kernelCalls, 0, '被裁决为失败的请求一律不得触碰内核');
  }],
]);
