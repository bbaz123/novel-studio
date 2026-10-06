// 生成并运行「2026-10-05 修稿合并报障」的定向回归副本。
// 为什么要生成副本：作者的约束是"修复前端只允许改 public/ 下三个文件"，
// 因此**不修改**仓库里的 frontend-test.mjs；这里把它整份复制、只在结尾汇总前插入本轮的回归用例，
// 于是这次运行同时包含①全量既有用例（回归）②本轮新增用例（新行为）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = fs.readFileSync(path.join(root, 'frontend-test.mjs'), 'utf8');

const MARKER = "console.log(`\\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);";
if (!original.includes(MARKER)) {
  console.error('未找到汇总标记，拒绝生成（避免把用例插到错误位置）');
  process.exit(2);
}

const injected = `
// ==================== 2026-10-05 报障：修稿完成后「无法合并到正文」 ====================
// 库内取证（本轮实际查到的）：作者点「合并到正文」之后，采纳台账 adoption_operations 里
// **没有**这一笔；而章节正文变成了"旧段落 + 新段落"两份叠在一起的混合稿 —— 120 段全部来自
// AI 稿与那 28 条修订，没有一段是作者自己写的（逐段核对：AI 原文 64 / 修订前锚点 28 / 修订后 28 / 未归类 0）。
// 也就是说：合并根本没落地，作者只能把差异预览里的文字手工抄进编辑器，于是正文变成两份。
// 这条回归钉三件事：
//   ① 合并被拒 / 失败时**不消费**这份修稿稿（旧实现在任何校验之前就清成 null：弹窗还开着、
//      按钮还在，再点却什么都不发生 —— 下次只能重跑几分钟的付费审稿 + 修稿）；
//   ② 采纳成功之后本地基线（updated_at）必须同步，且编辑器里**别的章**的待落盘稿子不受影响；
//   ③ 采纳之后的整页刷新失败**不得**被报成「合并失败：本地内容尚未保存，请先处理保存冲突」。
{
  const savedChapters = P.state.chapters; const savedWorkId = P.state.workId;
  const savedCurrent = P.state.currentChapterId;
  const savedNodes = {
    editor: containers['#editor-content'], title: containers['#editor-title'], status: containers['#editor-status']
  };
  const savedApi = sandbox.api; const savedToast = sandbox.toast;
  const savedPending = P.state.pendingReviewDiff; const savedDraft = P.state.chapterDraft;
  const savedEmpty = P.state.editorEmptyBlocked; const savedConflict = P.state.editorConflictSnapshot;
  const savedFailed = P.state.editorSaveFailedSnapshot; const savedSnap = P.state.editorSaveSnapshot;
  const savedRecoveryFor = P.state.recoveryForChapter;

  const editor = mkEl('editor-content', 'div');
  editor.dataset.chapterId = '121';
  editor.innerHTML = '<p>编辑器里这一版</p>';
  containers['#editor-content'] = editor;
  const title = mkEl('editor-title', 'input'); title.value = '第一章'; containers['#editor-title'] = title;
  containers['#editor-status'] = mkEl('editor-status', 'div');
  P.state.workId = 18; P.state.currentChapterId = 121;
  P.state.chapters = [{ id: 121, title: '第一章', content: '<p>库里的正文</p>', summary: '', updated_at: 'base-1' }];
  P.state.editorEmptyBlocked = null; P.state.editorConflictSnapshot = null;
  P.state.editorSaveFailedSnapshot = null; P.state.editorSaveSnapshot = null;
  P.state.chapterDraft = null; P.state.recoveryForChapter = 121;
  P.state.chapterBodyPeak.delete(121);
  const msgs = [];
  sandbox.toast = (m) => msgs.push(String(m));
  const savedTimer = P.state.editorSaveTimer;

  // ---- M1：被"原文保真闸门"拒绝 → 这份修稿必须留着 ----
  let adoptCalls = 0;
  sandbox.api = async (url) => {
    if (String(url).includes('/novel/adopt')) adoptCalls += 1;
    return { ok: true };
  };
  P.state.pendingReviewDiff = {
    newText: '修好的正文', chapterId: 121, baseFingerprint: 'fnv1a:deadbeef:3',
    proposalIds: [], operationKey: 'merge-121-test-1'
  };
  msgs.length = 0;
  await P.mergeReviewDiff();
  check('P-MERGE-1 合并被原文闸门拒绝时：不发采纳请求，且这份修稿仍然保留（可原地重试）',
    adoptCalls === 0 && !!P.state.pendingReviewDiff && P.state.pendingReviewDiff.newText === '修好的正文'
      && msgs.some((m) => m.includes('仍然保留')),
    \`adopt=\${adoptCalls} pending=\${!!P.state.pendingReviewDiff} msgs=\${JSON.stringify(msgs)}\`);

  // ---- M2：采纳失败（409）→ 同样保留，并如实说"可再次点合并重试" ----
  sandbox.api = async (url) => {
    if (String(url).includes('/novel/adopt')) {
      const e = new Error('采纳失败（已整体回滚，未写入任何内容）：正文已被改动');
      e.status = 409;
      throw e;
    }
    return { ok: true };
  };
  P.state.pendingReviewDiff = {
    newText: '修好的正文', chapterId: 121, baseFingerprint: '',
    proposalIds: [], operationKey: 'merge-121-test-2'
  };
  msgs.length = 0;
  await P.mergeReviewDiff();
  check('P-MERGE-2 采纳失败时这份修稿仍在，提示明确"可再次点合并重试"',
    !!P.state.pendingReviewDiff && msgs.some((m) => m.includes('合并失败') && m.includes('重试')),
    \`pending=\${!!P.state.pendingReviewDiff} msgs=\${JSON.stringify(msgs)}\`);

  // ---- M3：采纳成功 + 整页刷新失败 → 不得报成"合并失败"，且基线同步、别的章的状态不动 ----
  const order = []; const adoptBodies = [];
  sandbox.api = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/novel/adopt')) {
      order.push('adopt');
      adoptBodies.push(typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {}));
      return { ok: true, adopt: { legacy: { events: 0, memories: 0 }, chapter_updated_at: 'merged-1' } };
    }
    if (u.includes('/chapters/121')) {
      order.push('put:121');
      return { id: 121, title: '第一章', content: '<p>编辑器里这一版</p>', summary: '', updated_at: 'editor-saved-1' };
    }
    if (u.includes('/harness/recoverable')) return { jobs: [] };
    if (u.includes('/novel/draft')) return { draft: null };
    if (u.includes('/novel/review')) return { review: null };
    throw new Error('refresh-boom');   // 让 loadWorkData 的整页刷新真的失败
  };
  // 编辑器里确实有一份待落盘的稿子（模拟作者刚敲完字就点了合并）
  P.state.editorSaveSnapshot = { id: 121, content: '<p>编辑器里这一版</p>', title: '第一章' };
  // 另一章的空内容暂停态：合并这一章时一个字都不该碰它
  P.state.editorEmptyBlocked = { id: 999, content: '', title: '别的章' };
  P.state.pendingReviewDiff = {
    newText: '修好的正文', chapterId: 121, baseFingerprint: '',
    proposalIds: [], operationKey: 'merge-121-test-3'
  };
  msgs.length = 0;
  order.length = 0;
  await P.mergeReviewDiff();
  const chapterAfter = P.state.chapters.find((c) => c.id === 121) || {};
  check('P-MERGE-3 合并之前先按合并前的基线落盘（不是合并之后才落盘，那样必然撞乐观锁）',
    order[0] === 'put:121' && order[1] === 'adopt',
    JSON.stringify(order));
  check('P-MERGE-4 采纳成功 → 写进去的是修订稿，本地基线同步为服务端版本标记，这份修稿才算消费掉',
    adoptBodies.length === 1 && String(adoptBodies[0].content).includes('修好的正文')
      && chapterAfter.updated_at === 'merged-1' && P.state.pendingReviewDiff === null,
    JSON.stringify({ content: String(adoptBodies[0] && adoptBodies[0].content).slice(0, 40), updated_at: chapterAfter.updated_at, pending: !!P.state.pendingReviewDiff }));
  check('P-MERGE-5 整页刷新失败不会被报成"合并失败"（正文已经在库里了）',
    !msgs.some((m) => m.includes('合并失败')) && msgs.some((m) => m.includes('已经合并到正文')),
    JSON.stringify(msgs));
  check('P-MERGE-6 只收口被合并这一章：别的章的暂停态不动，本章的待落盘稿子被合并结果取代',
    !!P.state.editorEmptyBlocked && Number(P.state.editorEmptyBlocked.id) === 999
      && P.state.editorSaveSnapshot === null,
    JSON.stringify({ other: P.state.editorEmptyBlocked && P.state.editorEmptyBlocked.id, snap: P.state.editorSaveSnapshot }));

  // 还原现场
  clearTimeout(P.state.editorSaveTimer);
  P.state.editorSaveTimer = savedTimer;
  sandbox.api = savedApi; sandbox.toast = savedToast;
  P.state.chapters = savedChapters; P.state.workId = savedWorkId; P.state.currentChapterId = savedCurrent;
  P.state.pendingReviewDiff = savedPending; P.state.chapterDraft = savedDraft;
  P.state.editorEmptyBlocked = savedEmpty; P.state.editorConflictSnapshot = savedConflict;
  P.state.editorSaveFailedSnapshot = savedFailed; P.state.editorSaveSnapshot = savedSnap;
  P.state.recoveryForChapter = savedRecoveryFor;
  P.state.chapterBodyPeak.delete(121);
  for (const [k, v] of Object.entries(savedNodes)) {
    const id = k === 'editor' ? 'editor-content' : k === 'title' ? 'editor-title' : 'editor-status';
    if (v) { containers['#' + id] = v; registered.set('#' + id, v); } else { containers['#' + id] = undefined; }
  }
}

// ==================== 2026-10-05 作者要求：保存层不得影响任何操作 ====================
// 要求原文："用户所做的一切为最高优先级，不论是否保存，未保存的弹窗提醒保存，并帮用户自动保存，
// 不得影响用户的所有操作。" 这组用例钉四件事：① 保存态不拦导航；② 409 的自动处置顺序
//（先给服务端那一版留历史版本，再写作者这一版）；③ 切章不丢稿、切回来显示作者那一版；
// ④ 空稿暂停时自动重试也绝不写库（不得自动清空已有正文）。
{
  const savedChapters = P.state.chapters; const savedWorkId = P.state.workId; const savedCurrent = P.state.currentChapterId;
  const savedApi = sandbox.api; const savedToast = sandbox.toast;
  const savedConflict = P.state.editorConflictSnapshot; const savedFailed = P.state.editorSaveFailedSnapshot;
  const savedEmpty = P.state.editorEmptyBlocked; const savedSnap = P.state.editorSaveSnapshot;
  const savedTimer = P.state.editorSaveTimer; const savedRetry = P.state.editorSaveRetryTimer;
  const savedNodes = { editor: containers['#editor-content'], title: containers['#editor-title'] };
  P.state.workId = 18; P.state.currentChapterId = 121;
  P.state.chapters = [{ id: 121, title: '第121章', content: '<p>库里的正文</p>', summary: '', updated_at: 'v1' }];
  P.state.editorSaveSnapshot = null; P.state.editorSaveFailedSnapshot = null;
  P.state.editorEmptyBlocked = null; P.state.editorConflictSnapshot = null;
  P.state.editorPendingByChapter.clear(); P.state.editorUnsavedNoticeKey = '';
  const msgs = []; sandbox.toast = (m) => msgs.push(String(m));
  const calls = [];
  const editor = mkEl('editor-content', 'div'); editor.dataset.chapterId = '121';
  editor.innerHTML = '<p>我手上这一版</p>';
  containers['#editor-content'] = editor;
  const title = mkEl('editor-title', 'input'); title.value = '第121章'; containers['#editor-title'] = title;

  // ① 409 冲突不再拦导航
  P.state.editorConflictSnapshot = { id: 121, content: '<p>我手上这一版</p>', title: '第121章' };
  sandbox.api = async (url) => { calls.push(String(url)); return { ok: true }; };
  const navOk = await P.ensureSavedBeforeNavigation();
  check('P-SAVE-1 有 409 冲突时导航照常放行（保存态不再拦任何操作）', navOk === true, 'navOk=' + navOk);

  // ② 自动处置冲突：先备份服务端那一版，再写作者这一版
  calls.length = 0; msgs.length = 0;
  sandbox.api = async (url, opts = {}) => {
    const u = String(url); calls.push(u + ' ' + String((opts && opts.method) || 'GET').toUpperCase());
    if (u.indexOf('/chapters/121') === 0 && String((opts && opts.method) || 'GET').toUpperCase() === 'PUT') {
      return { id: 121, title: '第121章', content: '<p>我手上这一版</p>', summary: '', updated_at: 'v2' };
    }
    if (u.indexOf('/chapters/121') === 0) return { id: 121, title: '第121章', content: '<p>库里的正文</p>', summary: '', updated_at: 'v2' };
    return { ok: true };
  };
  await P.retryUnsavedEditorSaves();
  // 注意：先有一次 GET /chapters/121 取最新章节（拿新基线），所以判据要看**方法**，不能只按前缀找。
  const getIdx = calls.findIndex((c) => c.indexOf('/chapters/121 GET') === 0);
  const vIdx = calls.findIndex((c) => c.indexOf('/chapter_versions POST') === 0);
  const pIdx = calls.findIndex((c) => c.indexOf('/chapters/121 PUT') === 0);
  check('P-SAVE-2 自动处置冲突：先把服务端那一版存进历史版本，再写入作者这一版（顺序不可反）',
    getIdx >= 0 && vIdx > getIdx && pIdx > vIdx && P.state.editorConflictSnapshot === null,
    JSON.stringify({ calls: calls, getIdx: getIdx, vIdx: vIdx, pIdx: pIdx, conflict: !!P.state.editorConflictSnapshot }));

  // ③ 切章不丢稿；切回来显示作者那一版
  P.state.editorConflictSnapshot = null; P.state.editorSaveFailedSnapshot = null;
  P.state.editorSaveSnapshot = { id: 121, content: '<p>我手上这一版</p>', title: '第121章' };
  editor.dataset.chapterId = '122'; P.state.currentChapterId = 122;
  P.scheduleSave();
  check('P-SAVE-3 切章时未落盘的稿子被转存（不会被新章的快照覆盖掉）',
    P.state.editorPendingByChapter.has(121) && Number(P.state.editorSaveSnapshot.id) === 122,
    JSON.stringify({ held: P.state.editorPendingByChapter.has(121), snap: P.state.editorSaveSnapshot && P.state.editorSaveSnapshot.id }));
  check('P-SAVE-4 切回该章时编辑器显示作者那一版（不是服务端那一版）',
    String(P.editorDraftHtmlFor(P.state.chapters.find((c) => c.id === 121))).indexOf('我手上这一版') >= 0, '');
  clearTimeout(P.state.editorSaveTimer); P.state.editorSaveTimer = null;

  // ④ 空稿暂停：自动重试绝不写库
  P.state.editorSaveSnapshot = null; P.state.editorPendingByChapter.clear();
  P.state.editorEmptyBlocked = { id: 121, content: '', title: '第121章' };
  calls.length = 0;
  await P.retryUnsavedEditorSaves();
  check('P-SAVE-5 空稿暂停时自动重试绝不写库（只提醒 + 给两条出路）',
    !calls.some((u) => u.indexOf('/chapters/121') === 0), JSON.stringify({ calls: calls }));
  check('P-SAVE-6 有未保存内容时 hasUnsavedEditorWork 为真（关页面提醒与提醒条都靠它）',
    P.hasUnsavedEditorWork() === true, '');

  clearTimeout(P.state.editorSaveTimer); clearTimeout(P.state.editorSaveRetryTimer);
  P.state.editorSaveTimer = savedTimer; P.state.editorSaveRetryTimer = savedRetry;
  sandbox.api = savedApi; sandbox.toast = savedToast;
  P.state.chapters = savedChapters; P.state.workId = savedWorkId; P.state.currentChapterId = savedCurrent;
  P.state.editorConflictSnapshot = savedConflict; P.state.editorSaveFailedSnapshot = savedFailed;
  P.state.editorEmptyBlocked = savedEmpty; P.state.editorSaveSnapshot = savedSnap;
  P.state.editorPendingByChapter.clear();
  for (const [k, v] of Object.entries(savedNodes)) {
    const id = k === 'editor' ? 'editor-content' : 'editor-title';
    if (v) { containers['#' + id] = v; registered.set('#' + id, v); }
  }
}

`;// 本轮新增的用例要直接断言保存层的几个新函数，因此在这份**副本**里把它们也挂到探针上
//（仓库里的 frontend-test.mjs 一个字都不改）。
const PROBE_TAIL = "  longTextKindMeta, longTextCancelRun, buildAIPolishMessages, buildAIExpandMessages, buildAIPersonalityMessages\n};";
const PROBE_TAIL_NEW = "  longTextKindMeta, longTextCancelRun, buildAIPolishMessages, buildAIExpandMessages, buildAIPersonalityMessages,\n"
  + "  ensureSavedBeforeNavigation, retryUnsavedEditorSaves, hasUnsavedEditorWork, editorDraftHtmlFor,\n"
  + "  notifyUnsavedEditorWork, scheduleEditorSaveRetry, holdPendingEditorSnapshot\n};";
if (!original.includes(PROBE_TAIL)) {
  console.error('未找到探针导出列表的结尾，拒绝生成（避免把新函数挂错位置）');
  process.exit(2);
}
const out = original.replace(MARKER, injected + MARKER).replace(PROBE_TAIL, PROBE_TAIL_NEW);// 测试按**自身位置**解析 public/app.js、public/long-text.js、server.js（跨文件契约断言要用），
// 所以生成一个自带这几份文件的独立目录，而不是把副本扔在 .p1-baseline/ 根下（那样它会去找 .p1-baseline/public/app.js）。
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const appPath = path.resolve(root, arg('app', 'public/app.js'));
const outDir = path.resolve(root, arg('out', '.p1-baseline/regress-run'));
fs.mkdirSync(path.join(outDir, 'public'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'frontend-test-injected.mjs'), out, 'utf8');
fs.copyFileSync(appPath, path.join(outDir, 'public', 'app.js'));
fs.copyFileSync(path.join(root, 'public', 'long-text.js'), path.join(outDir, 'public', 'long-text.js'));
fs.copyFileSync(path.join(root, 'server.js'), path.join(outDir, 'server.js'));
console.log(`已生成: ${outDir}（测试 ${out.length} 字节；被测 app.js 来自 ${appPath}）`);

const run = process.argv.includes('--run');
if (run) {
  console.log('提示：子进程捕获输出在本机沙箱下会 EPERM（已实测），请直接用 node 运行生成目录里的测试文件。');
}
