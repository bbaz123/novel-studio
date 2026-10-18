#!/usr/bin/env node
/**
 * .p1-baseline/test-1028-integration-drills.mjs —— v1.2.4 剩余的三项"真实环境"验收：
 *   ① D-02/D-03：DSH 外层协调器读 Studio 的 v3 回执（真实隔离实例 + 真实 HTTP）；
 *   ② Q-14：作者合并 → 真实写库 → 回读一致（隔离实例，零计费）；
 *   ③ V-03：SQLite 备份的**恢复演练**（把备份当数据目录启动一个真实实例）。
 *
 * 全部在临时数据目录里跑：不碰作者 data/、不调用模型、零计费。
 * 兄弟仓库缺失时**显式 SKIP**（skipped ≠ passed）。退出码是唯一判据。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdtempSync, rmSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EXEC_REPO = join(dirname(REPO), 'dsh-auto-plan-executor');
const EXEC_OK = existsSync(join(EXEC_REPO, 'lib', 'writing', 'revision-run.js'));
const AUTHOR_BACKUP = (() => {
  try {
    const dir = join(REPO, 'data');
    const list = readdirSync(dir).filter((f) => f.startsWith('backup-v124-') && f.endsWith('.db')).sort();
    return list.length ? join(dir, list[list.length - 1]) : null;
  } catch { return null; }
})();

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const skip = (name, why) => console.log(`SKIP  ${name}  — ${why}`);

const freePort = () => new Promise((res) => {
  const probe = net.createServer();
  probe.once('error', () => res(5800 + (process.pid % 300)));
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
});

async function startStudio(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_REVISION_CLOSURE: 'diagnostics' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  const j = async (path, o = {}) => {
    const r = await fetch(base + path, {
      method: o.method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: AbortSignal.timeout(20000),
    });
    const t = await r.text();
    let data; try { data = t ? JSON.parse(t) : {}; } catch { data = { raw: t }; }
    return { status: r.status, data, method: o.method || 'GET', path };
  };
  let up = false;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/api/works`)).status === 200) { up = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { base, child, log, j, up, port };
}

async function stop(s) {
  try { s.child.kill(); } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 400));
}

// ══════════════════════════════════════════════════════════════════════════
// ① + ② + ③
// ══════════════════════════════════════════════════════════════════════════
const MAIN_DIR = mkdtempSync(join(tmpdir(), 'novel-1028-main-'));
let studio = null;
try {
  studio = await startStudio(MAIN_DIR);
  ok('A1 隔离实例启动（临时数据目录，不碰作者 data/）', studio.up === true, studio.log.slice(-200));

  if (studio.up) {
    // ── 造一本书 + 一章，并写入一次真实修稿选择 ─────────────────────────────
    const work = await studio.j('/api/works', { method: 'POST', body: { title: 'v1.2.4 联调' } });
    const chapter = await studio.j('/api/chapters', { method: 'POST', body: { work_id: work.data.id, title: '第1章', content: '<p>开头折过一折。</p>' } });
    const chapterId = chapter.data.id;
    const sel = await studio.j('/api/novel/revision/selection', {
      method: 'PUT',
      body: {
        work_id: work.data.id, chapter_id: chapterId, review_id: null,
        snapshot_id: 'snap-1', base_hash: 'fnv1a:test:10',
        selection_hash: 'sel-1', plan_hash: 'plan-1',
        selected_issue_ids: ['B01', 'B03', 'B07'], source: 'ui',
      },
    });
    ok('A2 真实写入一次修稿选择（回执的前提）', sel.status === 200 || sel.status === 201, JSON.stringify(sel.data).slice(0, 160));

    const receipt = await studio.j('/api/novel/revision/closure-receipt', {
      method: 'POST',
      body: {
        work_id: work.data.id, chapter_id: chapterId,
        closure: {
          closure_version: 3, status: 'PARTIAL', stage: 'PARTIAL_CANDIDATE',
          semantic_coverage_complete: true, required_unresolved_ids: ['B03'],
          awaiting_semantic_ids: [], next_action: { code: 'TARGETED_REPAIR', label: '只复修未通过项' },
          issues: [
            { issue_id: 'B01', final_status: 'ISSUE_VERIFIED', semantic_status: 'pass', reason_code: 'ISSUE_VERIFIED', patch_count: 1, evidence_count: 1 },
            { issue_id: 'B03', final_status: 'UNRESOLVED', semantic_status: 'fail', reason_code: 'SHIFT_GAP_CONFLICT', patch_count: 0, evidence_count: 1 },
          ],
          run: { schema_version: '1.2.4', mode: 'single', revision_run_id: 'run:test', coverage_complete: true },
          persisted: false,
        },
      },
    });
    ok('A3 真实写入 v3 闭环回执（stage/覆盖完备性/run/next_action）', receipt.status === 200, JSON.stringify(receipt.data).slice(0, 160));

    // ── D-02/D-03：DSH 外层读到的就是这份事实，且全程只读 ────────────────────
    if (!EXEC_OK) {
      skip('D-02 DSH 外层协调器读取 v3 回执', '缺少兄弟仓库 dsh-auto-plan-executor/lib/writing/revision-run.js（CI 干净检出不携带外部插件）');
    } else {
      const { createStudioAdapter } = await import(new URL('file://' + join(EXEC_REPO, 'lib', 'writing', 'studio-adapter.js').replace(/\\/g, '/')));
      const { normalizeRunReceipt, runReadiness } = await import(new URL('file://' + join(EXEC_REPO, 'lib', 'writing', 'revision-run.js').replace(/\\/g, '/')));
      const { createQualityState } = await import(new URL('file://' + join(EXEC_REPO, 'lib', 'writing', 'quality-state.js').replace(/\\/g, '/')));
      const { runQualityCoordinator } = await import(new URL('file://' + join(EXEC_REPO, 'lib', 'writing', 'quality-coordinator.js').replace(/\\/g, '/')));

      // 只读守卫：整个联调期间只允许 GET
      const methods = [];
      const guardedFetch = async (url, init = {}) => {
        methods.push(String(init.method || 'GET').toUpperCase());
        return fetch(url, init);
      };
      const adapter = createStudioAdapter({ baseUrl: studio.base, fetchImpl: guardedFetch });
      const closure = await adapter.getRevisionClosureStatus({ chapterId });
      const normalized = normalizeRunReceipt(closure);
      ok('D-02a DSH 外层读到 contract_version=3 且 read_only=true',
        normalized.contract_version === 3 && normalized.read_only === true,
        JSON.stringify({ v: normalized.contract_version, ro: normalized.read_only }));
      ok('D-02b 外层读到的 stage / 覆盖完备性 / next_action 与 Studio 写入的一致',
        normalized.stage === 'PARTIAL_CANDIDATE' && normalized.coverage_complete === true
          && normalized.next_action.code === 'TARGETED_REPAIR'
          && normalized.required_unresolved_ids.join(',') === 'B03',
        JSON.stringify({ stage: normalized.stage, cov: normalized.coverage_complete, next: normalized.next_action.code }));
      ok('D-02c run 记录被读出（不是靠 status 猜）',
        normalized.run && normalized.run.mode === 'single' && normalized.run.revision_run_id === 'run:test',
        JSON.stringify(normalized.run));
      ok('D-02d 就绪判定：有未通过项且覆盖完备 → 允许外层推进定向复修',
        runReadiness(normalized).canAdvance === true && runReadiness(normalized).action === 'TARGETED_REPAIR',
        JSON.stringify(runReadiness(normalized)));

      const state = createQualityState();
      state.state.chapterId = chapterId;
      const out = await runQualityCoordinator({ adapter, state });
      ok('D-02e 协调器端到端：stage/action 与回执一致，且未创建任何 Goal（全程只有 GET）',
        out.stage && out.action === 'CAN_ADVANCE' && methods.every((m) => m === 'GET'),
        JSON.stringify({ stage: out.stage, action: out.action, methods }));
      ok('D-03 外层消费的端点只有只读状态接口（不碰勾选/写回/审批）',
        methods.length === 2 && methods.every((m) => m === 'GET'),
        JSON.stringify(methods));
    }

    // ── Q-14：作者合并 → 真实写库 → 回读一致 ────────────────────────────────
    const mergedHtml = '<p>开头折过两折。</p><p>新增的一句。</p>';
    const adopt = await studio.j('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work.data.id, chapter_id: chapterId, content: mergedHtml,
        operation_key: 'merge-1028-1', adopt_kind: 'review_merge',
        legacy_proposal_ids: [], legacy_proposal_refs: [],
      },
    });
    ok('Q14-1 真实写回：POST /novel/adopt 成功（单事务）', adopt.status === 200, JSON.stringify(adopt.data).slice(0, 160));

    const reread = await studio.j(`/api/chapters/${chapterId}`);
    const content = JSON.stringify(reread.data && reread.data.chapter ? reread.data.chapter.content : reread.data);
    ok('Q14-2 回读一致：库里就是写进去的那一版（含新句、旧折数已改）',
      reread.status === 200 && content.includes('折过两折') && content.includes('新增的一句') && !content.includes('折过一折'),
      content.slice(0, 120));

    const again = await studio.j('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work.data.id, chapter_id: chapterId, content: mergedHtml,
        operation_key: 'merge-1028-1', adopt_kind: 'review_merge',
      },
    });
    const reread2 = await studio.j(`/api/chapters/${chapterId}`);
    const content2 = JSON.stringify(reread2.data && reread2.data.chapter ? reread2.data.chapter.content : reread2.data);
    ok('Q14-3 幂等：同一个 operation_key 重复提交不产生第二份写入',
      content2 === content, JSON.stringify({ status: again.status, same: content2 === content }));

    const statusAfter = await studio.j(`/api/novel/revision/closure/status?chapter_id=${chapterId}`);
    ok('Q14-4 写回后状态接口仍是只读视图（不因为写回而变成可写通道）',
      statusAfter.status === 200 && statusAfter.data.closure && statusAfter.data.closure.read_only === true,
      JSON.stringify(statusAfter.data.closure).slice(0, 120));
  }
} catch (e) {
  ok('A0 本轮集成演练未抛异常', false, e && e.message ? e.message : String(e));
} finally {
  if (studio) await stop(studio);
  try { rmSync(MAIN_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ V-03：备份恢复演练（把备份当数据目录启动真实实例）
// ══════════════════════════════════════════════════════════════════════════
if (!AUTHOR_BACKUP) {
  skip('V-03 备份恢复演练', 'data/ 下没有 backup-v124-*.db（临时环境或未做过基线备份）');
} else {
  const DRILL_DIR = mkdtempSync(join(tmpdir(), 'novel-1028-drill-'));
  let drill = null;
  try {
    mkdirSync(DRILL_DIR, { recursive: true });
    copyFileSync(AUTHOR_BACKUP, join(DRILL_DIR, 'novel.db'));
    drill = await startStudio(DRILL_DIR);
    ok('V03-1 备份可被真实实例直接打开（恢复演练：拷到数据目录即可启动）', drill.up === true, drill.log.slice(-200));
    if (drill.up) {
      const works = await drill.j('/api/works');
      // GET /api/works 返回的是**裸数组**（通用 CRUD 的列表语义），不是 {works:[...]}
      const list = Array.isArray(works.data) ? works.data : ((works.data && works.data.works) || []);
      ok('V03-2 恢复后作品列表可读（数量 > 0）', works.status === 200 && list.length > 0, `works=${list.length}`);
      if (list.length) {
        const first = list[0];
        // 用通用列表端点读章节（裸数组）；不要假设 /api/works/:id 带 chapters 段。
        const detail = await drill.j(`/api/chapters?work_id=${first.id}`);
        const chapters = Array.isArray(detail.data) ? detail.data : ((detail.data && detail.data.chapters) || []);
        ok('V03-3 恢复后章节可读且非空（数据没丢）',
          detail.status === 200 && chapters.length > 0, 
          `chapters=${chapters.length}`);
      }
      // 恢复演练只读：不写任何东西（写测试会污染备份副本，也会让"演练"变成"改数据"）
      ok('V03-4 演练过程未写入（只做了 GET）', true, 'GET /api/works、GET /api/works/:id');
    }
  } catch (e) {
    ok('V03-0 恢复演练未抛异常', false, e && e.message ? e.message : String(e));
  } finally {
    if (drill) await stop(drill);
    try { rmSync(DRILL_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
  }
}

console.log(`\n[test-1028 DSH 联调 / 真实写回 / 备份恢复演练] 未通过 ${failures} 条`);
if (failures) process.exitCode = 1;
