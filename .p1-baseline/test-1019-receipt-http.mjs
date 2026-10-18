#!/usr/bin/env node
/**
 * .p1-baseline/test-1019-receipt-http.mjs —— v1.2.1 质量闭环 P0-7/P0-9：回执与只读状态端点。
 *
 * 边界（方案 §7.4 / §13.5）：
 *   · 回执只附加到**本章最近一次选择记录**，不改勾选集合、不改正文、不新建选择；
 *   · 状态接口只读：不触发复修、不写库、不调用模型；
 *   · 模型通道（X-Novel-Agent）不能写回执（作者通道限定）；
 *   · `NOVELSTUDIO_REVISION_CLOSURE=off` 时回执被拒、状态如实返回 off。
 *
 * 零计费、离线、隔离实例 + 临时数据目录；退出码是唯一判据。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const AGENT = { 'x-novel-agent': '1' };
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};

const freePort = () => new Promise((res) => {
  const probe = net.createServer();
  probe.once('error', () => res(5600 + (process.pid % 400)));
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1019-t05-'));
const PORT_OFF = await freePort();
const BASE_OFF = `http://127.0.0.1:${PORT_OFF}`;
const DATA_DIR_OFF = mkdtempSync(join(tmpdir(), 'novel-1019-t05-off-'));

function startServer(port, dataDir, closureMode) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      NOVELSTUDIO_DATA_DIR: dataDir,
      NOVELSTUDIO_OV_DISABLED: '1',
      NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1',
      NOVELSTUDIO_REVISION_CLOSURE: closureMode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { text: '' };
  child.stdout.on('data', (c) => { log.text += c; });
  child.stderr.on('data', (c) => { log.text += c; });
  return { child, log };
}

async function ready(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/api/works`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return true;
    } catch (_) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function j(base, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const main = startServer(PORT, DATA_DIR, 'diagnostics');
const off = startServer(PORT_OFF, DATA_DIR_OFF, 'off');
if (!(await ready(BASE)) || !(await ready(BASE_OFF))) {
  console.error('实例未就绪\n' + main.log.text.slice(-2000) + '\n' + off.log.text.slice(-2000));
  main.child.kill(); off.child.kill();
  process.exit(2);
}

try {
  const workId = (await j(BASE, '/api/works', { method: 'POST', body: { title: '闭环回执' } })).data.id;
  const chapterId = (await j(BASE, '/api/chapters', { method: 'POST', body: { work_id: workId, title: '第1章', content: '<p>正文</p>' } })).data.id;
  const chapter2 = (await j(BASE, '/api/chapters', { method: 'POST', body: { work_id: workId, title: '第2章', content: '<p>另一章</p>' } })).data.id;

  console.log('【A. 只读状态：尚未修稿】');
  {
    const r = await j(BASE, `/api/novel/revision/closure/status?chapter_id=${chapterId}`);
    ok('A 无选择记录时状态接口 200 且 selection_id=null',
      r.status === 200 && r.data.closure.selection_id === null && r.data.closure.receipt === null,
      JSON.stringify(r.data).slice(0, 200));
    ok('A 状态接口标明 read_only=true（不触发复修）',
      r.data.closure.read_only === true && r.data.closure.contract_version === 2);
    ok('A 默认模式是 diagnostics（自动二次复修默认关闭）',
      r.data.closure.enabled === 'diagnostics', r.data.closure.enabled);
    ok('A 缺 chapter_id → 400；章节不存在 → 404',
      (await j(BASE, '/api/novel/revision/closure/status')).status === 400
      && (await j(BASE, '/api/novel/revision/closure/status?chapter_id=999999')).status === 404);
  }

  console.log('【B. 回执只附加到已有选择记录】');
  {
    const noSel = await j(BASE, '/api/novel/revision/closure-receipt', {
      method: 'POST', body: { chapter_id: chapter2, closure: { closure_version: 2 } },
    });
    ok('B 没有选择记录时回执 404（不能凭空创建一次修稿）', noSel.status === 404, JSON.stringify(noSel.data));

    const put = await j(BASE, '/api/novel/revision/selection', {
      method: 'PUT',
      body: {
        work_id: workId, chapter_id: chapterId, review_id: 7,
        snapshot_id: 'snap-1', base_hash: 'hash-1', selection_hash: 'sel-1', plan_hash: 'plan-1',
        selected_issue_ids: ['R-0001', 'R-0002'],
      },
    });
    ok('B 选择记录写入成功', put.status === 201 && Number(put.data.selection_id) > 0, JSON.stringify(put.data));
    const selectionId = put.data.selection_id;

    const receipt = {
      closure_version: 2,
      status: 'PARTIAL',
      metrics: { selection_count: 2, plan_located_count: 2, patch_applied_count: 3, semantic_verified_count: 1, unresolved_count: 1 },
      issues: [
        { issue_id: 'R-0001', final_status: 'ISSUE_VERIFIED', semantic_status: 'pass' },
        { issue_id: 'R-0002', final_status: 'AWAITING_SEMANTIC', semantic_status: 'not_run' },
      ],
      verdict: { status: 'PARTIAL', reason: '1 条待语义复核' },
      persisted: false,
    };
    const post = await j(BASE, '/api/novel/revision/closure-receipt', {
      method: 'POST', body: { work_id: workId, chapter_id: chapterId, closure: receipt },
    });
    ok('B 回执写入成功并绑定同一条选择记录',
      post.status === 200 && post.data.selection_id === selectionId && post.data.mode === 'diagnostics',
      JSON.stringify(post.data));

    const status = await j(BASE, `/api/novel/revision/closure/status?chapter_id=${chapterId}`);
    ok('B 状态接口返回回执（逐条状态可读）',
      status.data.closure.receipt && status.data.closure.receipt.metrics.semantic_verified_count === 1
      && status.data.closure.receipt.issues.length === 2,
      JSON.stringify(status.data.closure.receipt).slice(0, 220));

    const sel = await j(BASE, `/api/novel/revision/selection?chapter_id=${chapterId}`);
    ok('B 回执不改勾选集合（selected_issue_ids 原样）',
      sel.data.selection && sel.data.selection.id === selectionId
      && sel.data.selection.selected_issue_ids.join(',') === 'R-0001,R-0002',
      JSON.stringify(sel.data.selection && sel.data.selection.selected_issue_ids));
    ok('B 回执不新建选择记录（最新记录 id 不变）',
      sel.data.selection.id === selectionId, String(sel.data.selection.id));

    const content = await j(BASE, `/api/chapters/${chapterId}`);
    const bodyText = JSON.stringify(content.data);
    ok('B 回执不改章节正文（仍含原文 <p>正文</p>）',
      content.status === 200 && bodyText.includes('正文'), String(content.status));

    const again = await j(BASE, '/api/novel/revision/closure-receipt', {
      method: 'POST', body: { chapter_id: chapterId, closure: { ...receipt, status: 'BLOCKED', reason: '测试二次回执' } },
    });
    const statusAgain = await j(BASE, `/api/novel/revision/closure/status?chapter_id=${chapterId}`);
    ok('B 二次回执覆盖同一条记录（仍是同一 selection_id，不产生新行）',
      again.status === 200 && again.data.selection_id === selectionId
      && statusAgain.data.closure.receipt.status === 'BLOCKED',
      JSON.stringify({ id: again.data.selection_id, status: statusAgain.data.closure.receipt.status }));
  }

  console.log('【C. 权限与大小边界】');
  {
    const agent = await j(BASE, '/api/novel/revision/closure-receipt', {
      method: 'POST', headers: AGENT, body: { chapter_id: chapterId, closure: { closure_version: 2 } },
    });
    ok('C 模型通道写回执 → 403（作者通道限定）', agent.status === 403, String(agent.status));

    const huge = { closure_version: 2, blob: 'x'.repeat(70 * 1024) };
    const big = await j(BASE, '/api/novel/revision/closure-receipt', {
      method: 'POST', body: { chapter_id: chapterId, closure: huge },
    });
    ok('C 回执超过 64KB → 413（只上报摘要，不塞正文/日志）', big.status === 413, String(big.status));

    const notObject = await j(BASE, '/api/novel/revision/closure-receipt', {
      method: 'POST', body: { chapter_id: chapterId, closure: ['x'] },
    });
    ok('C closure 不是对象 → 400', notObject.status === 400, String(notObject.status));

    const mismatch = await j(BASE, '/api/novel/revision/closure-receipt', {
      method: 'POST', body: { work_id: workId + 999, chapter_id: chapterId, closure: { closure_version: 2 } },
    });
    ok('C work_id 与章节不符 → 400（不能跨作品写回执）', mismatch.status === 400, String(mismatch.status));
  }

  console.log('【D. 关闭模式】');
  {
    const offStatus = await j(BASE_OFF, `/api/novel/revision/closure/status?chapter_id=1`);
    ok('D off 模式：状态接口如实返回 enabled=off（而不是假装正常）',
      offStatus.status === 404 || offStatus.data.closure.enabled === 'off',
      JSON.stringify(offStatus.data).slice(0, 160));
    // 在 off 实例里建一章并写选择记录，再验证回执被拒。
    const w = (await j(BASE_OFF, '/api/works', { method: 'POST', body: { title: 'off' } })).data.id;
    const c = (await j(BASE_OFF, '/api/chapters', { method: 'POST', body: { work_id: w, title: '第1章', content: '<p>正文</p>' } })).data.id;
    await j(BASE_OFF, '/api/novel/revision/selection', {
      method: 'PUT', body: { work_id: w, chapter_id: c, selected_issue_ids: ['R-1'] },
    });
    const st = await j(BASE_OFF, `/api/novel/revision/closure/status?chapter_id=${c}`);
    const post = await j(BASE_OFF, '/api/novel/revision/closure-receipt', {
      method: 'POST', body: { chapter_id: c, closure: { closure_version: 2 } },
    });
    ok('D off 模式下回执被拒（409），状态仍可读',
      st.status === 200 && st.data.closure.enabled === 'off' && post.status === 409,
      JSON.stringify({ enable: st.data.closure && st.data.closure.enabled, post: post.status }));
  }
  console.log('【E. DSH 插件只读工具】');
  {
    const mod = await import(new URL('../harness-plugins/novel-writing/novel-tools.mjs', import.meta.url).href);
    const tools = new Map();
    mod.apply({ tools: { register: (def) => tools.set(def.name, def) } }, { baseUrl: BASE });
    process.env.NOVELSTUDIO_BASE_URL = BASE;
    const tool = tools.get('novel_revision_status');
    ok('E 插件注册了吗 novel_revision_status（只读工具，带 schema）',
      !!tool && typeof tool.execute === 'function' && !!tool.parameters,
      tool ? Object.keys(tool.parameters).join(',') : 'missing');
    const out = await tool.execute({ chapter_id: String(chapterId) });
    const text = String(out && out.text || '');
    ok('E 工具输出区分"应用补丁 / 语义通过 / 未入库"三件事',
      /应用补丁/.test(text) && /语义通过/.test(text) && /未入库/.test(text), text.slice(0, 260));
    ok('E 工具不把候选稿说成已修好',
      !/已修好|已全部修好/.test(text), text.slice(0, 160));
    ok('E 没有回执的章节如实说"回执：无"，不静默当通过',
      /回执：无/.test(await tool.execute({ chapter_id: String(chapter2) }).then((r) => String(r && r.text || ''))));
  }

} finally {
  main.child.kill();
  off.child.kill();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响断言 */ }
  try { rmSync(DATA_DIR_OFF, { recursive: true, force: true }); } catch (_) { /* 同上 */ }
  console.log(`\n[test-1019-receipt-http] 通过 ${pass} / 未通过 ${fails.length}`);
  if (!pass) { console.error('零用例：拒绝当作通过'); process.exit(2); }
  if (fails.length) process.exitCode = 1;
}
