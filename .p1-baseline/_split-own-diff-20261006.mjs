#!/usr/bin/env node
/**
 * 生成"只回滚本次修复"的补丁。
 *
 * 背景（必须理解，否则会误伤）：本仓库工作区里同时存在**两批**改动 ——
 *   ① 本次任务（采纳护栏不挡正文 / 提案引用带类型 / 旧内容是否保存）
 *   ② 另一个会话的「去 AI 味 第二批（诊断层）」（policy/long-text/插件 0.17.0 + defer子通道…）
 * 两批改动落在同一批文件（server.js / public/app.js）里，所以**整文件回滚会连带回退 ②**。
 *
 * 本脚本按 hunk 内容把它们分开：只把 ① 的 hunk 写成补丁。
 * 用法：
 *   node .p1-baseline/_split-own-diff-20261006.mjs            # 只分类并打印
 *   node .p1-baseline/_split-own-diff-20261006.mjs --write    # 写补丁文件
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['server.js', 'public/app.js', 'frontend-test.mjs', '.p1-baseline/test-adopt-atomic.mjs'];
const OUT = 'data/backup-20261006-adopt-guard/revert-this-change-only.patch';

// 本次修复独有的标记（出现在 hunk 的 +/- 行里即认定属于本次修复）
const MINE = [
  'normalizeProposalRefs', 'proposalRowOfRef', 'legacy_proposal_refs', 'legacyRefs',
  '旧提案未全部处理', 'guard_failed: legacyGuardFailed', 'selected: all ?',
  'settleOldContentBeforeOverwrite', 'askSaveOldContent', 'snapshotOldContentAsVersion',
  'pendingOldContent', 'save-old-content', 'pendingEditorSnapshotFor',
  'discardPendingEditorWorkFor', 'discardSupersededEditorWorkFor', 'reportLegacyGuardFailures',
  'ADOPT_CONFLICT_RE', 'proposalRefOf', 'collectCheckedProposalRefs', 'proposalIdsOfRefs',
  'data-proposal-ref', 'keptSelection', 'guardFailed', 'proposalRefs',
  '同号', '完整性（真正的"全有或全无"只剩这一类）',
];

// 明确的「另一批改动」标记（去 AI 味 第二批 / 诊断层）。宁可漏判成"自己的"也不能反着来 ——
// 反了会把别人的工作写进我的回滚补丁，那才是不可接受的错误。
const THEIRS = [
  'deferred_count', 'deferredNoteHtml', 'reviewDeferredItems', 'WRITING_POLICY_FALLBACK_VERSION',
  '2026-10-06.2', '最小改动', '高辨识度', '待后续核验',
];

const diff = execFileSync('git', ['diff', '--', ...FILES], { cwd: REPO, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
const lines = diff.split('\n');

const fileSections = [];
let cur = null;
for (const line of lines) {
  if (line.startsWith('diff --git ')) {
    cur = { header: [line], hunks: [] };
    fileSections.push(cur);
    continue;
  }
  if (!cur) continue;
  if (line.startsWith('@@')) { cur.hunks.push({ header: line, body: [line] }); continue; }
  if (cur.hunks.length) cur.hunks[cur.hunks.length - 1].body.push(line);
  else cur.header.push(line);
}

let mineCount = 0; const foreign = []; const own = [];
for (const sec of fileSections) {
  const file = (sec.header.find((l) => l.startsWith('+++ ')) || '').replace('+++ b/', '');
  for (const h of sec.hunks) {
    const text = h.body.join('\n');
    const hitsTheirs = THEIRS.some((m) => text.includes(m));
    const hitsMine = MINE.some((m) => text.includes(m));
    // 双向冲突时按"别人的"处理（宁可漏判自己的，也不误伤别人的）
    const isMine = hitsMine && !hitsTheirs;
    if (isMine) { mineCount += 1; own.push({ file, sec, h }); }
    else foreign.push({
      file, header: h.header, hitsTheirs, hitsMine,
      sample: h.body.filter((l) => l.startsWith('+') && !l.startsWith('+++')).slice(0, 2).map((l) => l.trim()).join(' | ').slice(0, 110),
    });
  }
}

console.log(`共 ${fileSections.reduce((n, s) => n + s.hunks.length, 0)} 个 hunk：本次修复 ${mineCount} 个，其它 ${foreign.length} 个`);
console.log('\n--- 全部 hunk 逐条核对（mine = 只有我的标记；theirs = 含另一批的标记；both = 两边都命中，按别人的处理）---');
for (const f of foreign) {
  const tag = f.hitsTheirs && f.hitsMine ? 'both' : f.hitsTheirs ? 'theirs' : 'OTHER';
  console.log(`  [${tag}] ${f.file} ${f.header}\n      ${f.sample}`);
}
console.log('\n--- 判定为本次修复的 hunk ---');
for (const o of own) {
  console.log(`  [mine] ${o.file} ${o.h.header}\n      ${o.h.body.filter((l) => l.startsWith('+') && !l.startsWith('+++')).slice(0, 2).map((l) => l.trim()).join(' | ').slice(0, 110)}`);
}

if (process.argv.includes('--write')) {
  const byFile = new Map();
  for (const o of own) {
    if (!byFile.has(o.sec)) byFile.set(o.sec, []);
    byFile.get(o.sec).push(o.h);
  }
  let out = '';
  for (const [sec, hunks] of byFile) {
    out += sec.header.join('\n') + '\n';
    for (const h of hunks) out += h.body.join('\n') + '\n';
  }
  writeFileSync(path.join(REPO, OUT), out, 'utf8');
  console.log(`\n已写出：${OUT}（${out.length} 字节，仅含本次修复的 ${mineCount} 个 hunk）`);
}
