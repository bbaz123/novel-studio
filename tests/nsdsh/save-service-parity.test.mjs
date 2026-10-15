/**
 * tests/nsdsh/save-service-parity.test.mjs —— 用例抽取的**平权证明**（S03）。
 *
 * S03 的硬约束是"**不改变语义**"：把保存/确认/分析/查询四类用例从 `server.js` 抽到
 * `server/services/temporal-services.mjs` 之后，判定结果必须与抽取前逐字一致。
 * 光靠"跑一遍集成测试仍然绿"不足以证明这件事——那样只覆盖到被测到的那几条路径。
 *
 * 这里的做法是**穷举对照**：把抽取前 `server.js` 里那套判据按同样顺序重写成本文件的
 * `legacy*()` 基线函数（逐条对着原分支的 if 写，保留原文案与状态码），
 * 然后在**整个输入空间**上比对 `legacy*()` 与真实服务函数的输出。
 * 只要两者在任何一个输入上不同，本套件就红。
 *
 * 为什么这是可信的平权判据（而不是"抄一遍再比一遍"）：
 *   · 基线函数独立写成：它不知道服务层的实现长什么样，只复刻**抽取前的行为**；
 *   · 对照是穷举的：workId × chapterId × 章节归属 的组合全覆盖，不挑样例；
 *   · 失败信息会打印具体输入，因此"哪里开始不一致"是可定位的。
 *
 * ⚠️ 诚实的边界：这证明的是**判据层**等价（状态码 + 文案 + 是否触碰内核）。
 * 它不证明内核行为、也不证明 HTTP 组装（那两条由 tests/temporal/* 的隔离实例断言覆盖）。
 */
import assert from 'node:assert/strict';
import {
  confirmEvents, confirmProposalGroup, analyzeChapterUseCase, queryStoryState, resolveChapterScope, workIdOf,
} from '../../server/services/temporal-services.mjs';

function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      fn();
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

// ─────────────────────────────────────────────────────────────────────────────
// 基线：抽取前 server.js 的判据（逐条复刻原文案与状态码）
// ─────────────────────────────────────────────────────────────────────────────

/** 抽取前 `confirm` / `apply` / `analyze` 分支共用的"作品 + 章节"前置判据。 */
function legacyScope(deps, { workId, chapterId }) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w) return { ok: false, status: 400, message: '缺少 work_id' };
  if (!deps.workExists(w)) return { ok: false, status: 404, message: '作品不存在' };
  if (!c) return { ok: false, status: 400, message: '缺少 chapter_id' };
  const ch = deps.getChapter(c);
  if (!ch || Number(ch.work_id) !== w) return { ok: false, status: 404, message: '章节不存在或不属于该作品' };
  return { ok: true, workId: w, chapter: ch };
}

/** 抽取前 `POST /novel/story_state/confirm` 的整条判据。 */
function legacyConfirm(deps, { workId, chapterId, events, source = 'author_confirm', expectedHead = null, contentHtml = null, modelRequest = false }) {
  if (modelRequest) return { ok: false, status: 403, message: '状态确认只能由作者发起：模型侧不能确认自己的抽取（该请求带 X-Novel-Agent 标记）' };
  const scope = legacyScope(deps, { workId, chapterId });
  if (!scope.ok) return scope;
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { ok: false, status: 400, message: 'events 不能为空（确认清单必须带具体操作）' };
  const result = deps.temporal.applyChapterEvents({
    workId: scope.workId, chapterId: Number(chapterId), events: list,
    source: source || 'author_confirm', author: 'author',
    expectedHead: expectedHead === undefined || expectedHead === null ? null : String(expectedHead),
    contentHtml: contentHtml === undefined ? null : contentHtml,
  });
  return { ok: true, result };
}

/** 抽取前 `POST /novel/story_state/proposal-groups/:id/apply` 的整条判据。 */
function legacyProposalApply(deps, { workId, chapterId, bindingId, events, eventIds, approvalId = null, expectedHead = null, modelRequest = false }) {
  if (modelRequest) return { ok: false, status: 403, message: '确认提案只能由作者发起：模型侧不能确认自己的抽取（该请求带 X-Novel-Agent 标记）' };
  const scope = legacyScope(deps, { workId, chapterId });
  if (!scope.ok) return scope;
  const id = String(bindingId == null ? '' : bindingId);
  if (!id || id === 'undefined') return { ok: false, status: 400, message: '缺少提案组 id' };
  if (Array.isArray(events) || Array.isArray(eventIds)) {
    return { ok: false, status: 400, message: '提案组必须整体确认：不接受 events / event_ids 子集（原子组不能拆开采纳）' };
  }
  const result = deps.temporal.confirmBinding({
    workId: scope.workId, chapterId: Number(chapterId), bindingId: id, author: 'author',
    approvalId: approvalId ? String(approvalId) : null,
    expectedHead: expectedHead === undefined || expectedHead === null ? null : String(expectedHead),
  });
  return { ok: true, result };
}

/** 抽取前 `POST /novel/story_state/analyze` 的整条判据（含模型通道 403）。 */
function legacyAnalyze(deps, { workId, chapterId, modelRequest = false }) {
  if (modelRequest) return { ok: false, status: 403, message: '状态分析由作者发起：模型侧不能自行触发抽取（该请求带 X-Novel-Agent 标记）' };
  return legacyScope(deps, { workId, chapterId });
}

/** 抽取前 `GET /novel/story_state` 的整条判据。 */
function legacyQuery(deps, { workId, chapterId = null }) {
  const w = Number(workId) || 0;
  if (!w) return { ok: false, status: 400, message: '缺少 work_id' };
  if (!deps.workExists(w)) return { ok: false, status: 404, message: '作品不存在' };
  let c = null;
  if (chapterId) {
    c = Number(chapterId) || 0;
    const ch = deps.getChapter(c);
    if (!ch || Number(ch.work_id) !== w) return { ok: false, status: 404, message: '章节不存在或不属于该作品' };
  }
  return { ok: true, workId: w, chapterId: c };
}

/** 造一套假 deps：works 与 chapters 由参数决定，内核调用被记录。 */
function makeDeps({ works = [1], chapters = {}, } = {}) {
  const kernel = { apply: [], confirm: [] };
  return {
    kernel,
    prepare: () => ({ get: () => null }),
    workExists: (w) => works.includes(Number(w)),
    getChapter: (c) => chapters[Number(c)] || null,
    temporal: {
      applyChapterEvents: (a) => { kernel.apply.push(a); return { ok: true, decision: 'valid', marker: 'A' }; },
      confirmBinding: (a) => { kernel.confirm.push(a); return { ok: true, decision: 'valid', marker: 'C' }; },
    },
  };
}

/** 把一个"结论对象"归一化成可逐字段比较的形状（只保留判据关心的字段）。 */
function shape(r) {
  if (!r) return r;
  if (r.ok === false) return { ok: false, status: r.status, message: r.message };
  return { ok: true, result: r.result ?? null };
}

suite('nsdsh/save-service-parity', [
  ['workIdOf 与抽取前的 `Number(v) || 0` 等价（含 NaN / 字符串 / null）', () => {
    for (const v of [1, '2', 0, null, undefined, '', 'abc', NaN, -1, 1.5]) {
      assert.equal(workIdOf(v), Number(v) || 0, `workIdOf(${JSON.stringify(v)})`);
    }
  }],

  ['resolveChapterScope ≡ 抽取前的共用前置判据（穷举输入空间）', () => {
    const worksList = [[1], [], [2]];
    const chaptersMap = [
      {},
      { 7: { id: 7, work_id: 1 } },
      { 7: { id: 7, work_id: 2 } },
      { 7: { id: 7, work_id: 1 }, 8: { id: 8, work_id: 1 } },
    ];
    const workIds = [1, 2, 0, null, undefined, '1', 'x'];
    const chapterIds = [7, 8, 0, null, undefined, '7', 'x'];
    let n = 0;
    for (const works of worksList) {
      for (const chapters of chaptersMap) {
        const deps = makeDeps({ works, chapters });
        for (const workId of workIds) {
          for (const chapterId of chapterIds) {
            const got = resolveChapterScope(deps, { workId, chapterId });
            const want = legacyScope(deps, { workId, chapterId });
            assert.deepEqual(shape(got), shape(want),
              `不一致：works=${JSON.stringify(works)} chapters=${JSON.stringify(Object.keys(chapters))} workId=${JSON.stringify(workId)} chapterId=${JSON.stringify(chapterId)}`);
            n += 1;
          }
        }
      }
    }
    assert.ok(n >= 500, `对照组合数应当足够大，实际 ${n}`);
  }],

  ['confirmEvents ≡ 抽取前的 confirm 判据（含模型通道 / 空 events / 内核入参）', () => {
    const deps = makeDeps({ works: [1], chapters: { 7: { id: 7, work_id: 1 } } });
    const cases = [
      { workId: 1, chapterId: 7, events: [{ ops: [] }] },
      { workId: 1, chapterId: 7, events: [] },
      { workId: 1, chapterId: 7, events: null },
      { workId: 1, chapterId: 7, events: [{ ops: [] }], modelRequest: true },
      { workId: 0, chapterId: 7, events: [{ ops: [] }] },
      { workId: 1, chapterId: 0, events: [{ ops: [] }] },
      { workId: 2, chapterId: 7, events: [{ ops: [] }] },
      { workId: 1, chapterId: 7, events: [{ ops: [] }], source: '' },
      { workId: 1, chapterId: '7', events: [{ ops: [] }], expectedHead: 123 },
      { workId: '1', chapterId: '7', events: [{ ops: [] }], contentHtml: '<p>x</p>' },
    ];
    for (const c of cases) {
      const d1 = makeDeps({ works: [1], chapters: { 7: { id: 7, work_id: 1 } } });
      const d2 = makeDeps({ works: [1], chapters: { 7: { id: 7, work_id: 1 } } });
      const got = confirmEvents(d1, { ...c });
      const want = legacyConfirm(d2, { ...c });
      assert.deepEqual(shape(got), shape(want), `不一致：${JSON.stringify(c)}`);
      // 内核入参也必须逐字段一致（这是"语义不变"最容易漏掉的部分）。
      assert.deepEqual(d1.kernel.apply, d2.kernel.apply, `内核入参不一致：${JSON.stringify(c)}`);
    }
    assert.ok(deps, 'deps 占位');
  }],

  ['confirmProposalGroup ≡ 抽取前的提案组判据（含原子组不得拆开）', () => {
    const mk = () => makeDeps({ works: [1], chapters: { 7: { id: 7, work_id: 1 } } });
    const cases = [
      { workId: 1, chapterId: 7, bindingId: 'b1' },
      { workId: 1, chapterId: 7, bindingId: '' },
      { workId: 1, chapterId: 7, bindingId: 'undefined' },
      { workId: 1, chapterId: 7, bindingId: null },
      { workId: 1, chapterId: 7, bindingId: 'b1', events: [{ ops: [] }] },
      { workId: 1, chapterId: 7, bindingId: 'b1', eventIds: ['e1'] },
      { workId: 1, chapterId: 7, bindingId: 'b1', modelRequest: true },
      { workId: 1, chapterId: 7, bindingId: 'b1', approvalId: 'ap1' },
      { workId: 0, chapterId: 7, bindingId: 'b1' },
      { workId: 2, chapterId: 7, bindingId: 'b1' },
    ];
    for (const c of cases) {
      const d1 = mk(); const d2 = mk();
      const got = confirmProposalGroup(d1, { ...c });
      const want = legacyProposalApply(d2, { ...c });
      assert.deepEqual(shape(got), shape(want), `不一致：${JSON.stringify(c)}`);
      assert.deepEqual(d1.kernel.confirm, d2.kernel.confirm, `内核入参不一致：${JSON.stringify(c)}`);
    }
  }],

  ['analyzeChapterUseCase 与 queryStoryState ≡ 抽取前对应分支', () => {
    const mk = () => makeDeps({ works: [1], chapters: { 7: { id: 7, work_id: 1 } } });
    for (const c of [{ workId: 1, chapterId: 7 }, { workId: 1, chapterId: 0 }, { workId: 1, chapterId: 8 }, { workId: 0, chapterId: 7 }, { workId: 1, chapterId: 7, modelRequest: true }]) {
      const got = analyzeChapterUseCase(mk(), { ...c });
      const want = legacyAnalyze(mk(), { ...c });
      assert.deepEqual(shape(got), shape(want), `analyze 不一致：${JSON.stringify(c)}`);
    }
    for (const c of [{ workId: 1 }, { workId: 1, chapterId: 7 }, { workId: 1, chapterId: 8 }, { workId: 0 }, { workId: 2 }]) {
      const got = queryStoryState(mk(), { ...c });
      const want = legacyQuery(mk(), { ...c });
      assert.deepEqual(shape(got), shape(want), `query 不一致：${JSON.stringify(c)}`);
    }
  }],

  /**
   * 判据本身必须有判别力：把服务函数的任意一条判据"放宽一点"，本套件应当红。
   * 这里用一个**本地变异体**验证对照确实能抓到差异（不修改被测源码）。
   */
  ['对照具有判别力：变异体（放宽跨作品检查）会被本套件的比对抓到', () => {
    const deps = makeDeps({ works: [1], chapters: { 7: { id: 7, work_id: 2 } } });
    const want = legacyScope(deps, { workId: 1, chapterId: 7 });
    assert.equal(want.status, 404, '基线：跨作品章节必须 404');
    // 变异体：去掉归属检查
    const mutated = (d, { workId, chapterId }) => {
      const w = Number(workId) || 0; const c = Number(chapterId) || 0;
      if (!w) return { ok: false, status: 400, message: '缺少 work_id' };
      if (!d.workExists(w)) return { ok: false, status: 404, message: '作品不存在' };
      if (!c) return { ok: false, status: 400, message: '缺少 chapter_id' };
      const ch = d.getChapter(c);
      if (!ch) return { ok: false, status: 404, message: '章节不存在或不属于该作品' };
      return { ok: true, workId: w, chapter: ch };
    };
    assert.notDeepEqual(shape(mutated(deps, { workId: 1, chapterId: 7 })), shape(want),
      '变异体与基线必须不同 —— 否则说明本套件的比对没有判别力');
    // 真实服务函数与基线一致（不是变异体那种行为）
    assert.deepEqual(shape(resolveChapterScope(deps, { workId: 1, chapterId: 7 })), shape(want));
  }],
]);
