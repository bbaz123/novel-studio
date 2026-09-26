#!/usr/bin/env node
/**
 * test-context-manifest.mjs —— 上下文清单 / 完整性 / 溯源的**离线单测**（零成本、不碰数据库）。
 *
 * 被验证的三件事（主体 V2 的 P0）：
 *   1. 清单要能回答"这段字从哪来、这次取了哪几行、为什么它在"（溯源）；
 *   2. 清单必须与**真正发出去的那段文字**自洽（完整性 PASS/WARNING/FAIL）；
 *   3. 身份（context_id 内容哈希 / request_id 装配身份）稳定且可复现。
 *
 * 核心方法是**阴性对照（变异测试）**：给每个判据各喂一份"应该失败"的输入。
 * 一条判据如果不能被故意破坏的输入判失败，它就只是装饰。
 *
 * 用法: node .p1-baseline/test-context-manifest.mjs
 */
import fs from 'node:fs';
import { assemble } from '../ai/context/assembler.mjs';
import { verifyContextIntegrity, shortHash } from '../ai/context/integrity.mjs';
import { estimateTokens, estimateTokensDetailed } from '../ai/context/tokens.mjs';
import { LAYERS, PROVENANCE, trimPriorityOf, RETRIEVAL } from '../ai/context/layers.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

/** 一份"和真实装配同形"的输入：14 层里取若干层，带溯源。 */
const layersOf = () => ([
  { id: 'work', label: '作品', kind: 'fixed', cap: 900, text: '书名：测试\n简介：一句话', sourceIds: [7] },
  { id: 'outline', label: '卷/剧情线/章节进度（大纲）', kind: 'flex', cap: 2800, text: '第1节 开端：主角进城', sourceIds: [11, 12] },
  { id: 'memory', label: '长期记忆（已发生的故事摘要）', kind: 'fixed', cap: 2200, text: '主角已进城。', sourceIds: [3] },
  { id: 'story_tail', label: '前文衔接', kind: 'flex', cap: 1600, floor: 400, text: '上一章的结尾……', sourceIds: [12] },
  { id: 'redlines', label: '写作风格红线', kind: 'fixed', cap: 4000, text: '禁止「心中一凛」', sourceIds: [1, 2] },
]);

const r = assemble(layersOf(), { mode: 'full', workId: 7, chapterId: 12, requestId: 'ctx-test-1' });

console.log('【1. 清单的溯源与身份字段】');
{
  const work = r.manifest.find((m) => m.id === 'work');
  ok('每层带 source（来源表/数据源）', r.manifest.every((m) => typeof m.source === 'string' && m.source.length > 0));
  ok('每层带本次实际取用的行 id（sourceId）', work.sourceId && work.sourceId[0] === 7, JSON.stringify(work.sourceId));
  ok('每层带时间视角 / 知识来源 / 选择方式',
    r.manifest.every((m) => m.temporalScope && m.knowledgeScope && m.selection),
    JSON.stringify(r.manifest.map((m) => [m.id, m.temporalScope, m.knowledgeScope, m.selection])));
  ok('每层带"为什么它值得占位置"', r.manifest.every((m) => m.reason && m.reason.length > 10));
  ok('每层带查回路径声明（可空，但字段必须在）', r.manifest.every((m) => 'recoveryPath' in m));
  ok('被裁层带 outcomeReason（为什么变成这样）', r.manifest.every((m) => typeof m.outcomeReason === 'string' && m.outcomeReason.length > 0));
  ok('裁剪优先级从 FLEX_ORDER/kind 派生（零损失层=never）',
    work.trimPriority === 'never' && r.manifest.find((m) => m.id === 'story_tail').trimPriority === 1,
    JSON.stringify(r.manifest.map((m) => [m.id, m.trimPriority])));
  ok('身份字段：context_id 是内容哈希、request_id 是本次装配',
    /^[0-9a-f]{12}$/.test(r.contextId) && r.envelope.requestId === 'ctx-test-1',
    `${r.contextId} / ${r.envelope.requestId}`);
  ok('envelope 带 work_id / chapter_id / budget / mode',
    r.envelope.workId === 7 && r.envelope.chapterId === 12 && r.envelope.budget > 0 && r.envelope.mode === 'full');
  const again = assemble(layersOf(), { mode: 'full', workId: 7, chapterId: 12, requestId: 'ctx-test-2' });
  ok('同一份内容装配两次 → context_id 相同（可复现）', again.contextId === r.contextId);
  ok('同一份内容装配两次 → request_id 不同（是"这一次装配"的身份）', again.envelope.requestId !== r.envelope.requestId);
}

console.log('\n【2. selected / trimmed / excluded（清单的信封）】');
{
  ok('selected = 本次实际装配的层 id', JSON.stringify(r.envelope.selected) === JSON.stringify(r.manifest.map((m) => m.id)));
  // 门控层（gated）不在这套层里：未打开开关时它既不进 manifest、也不进 excluded（Host Contract 1.1.0 §1）。
  const plainLayers = LAYERS.filter((l) => l.gated !== true);
  ok('excluded 覆盖"声明了但这次没装"的层，并给出原因',
    r.envelope.excluded.length === plainLayers.length - r.manifest.length
      && r.envelope.excluded.every((e) => e.id && e.reason),
    JSON.stringify(r.envelope.excluded.map((e) => e.id)));
  ok('未提供的门控层不在 excluded 里（它不属于这套层，不是"被裁掉"）',
    LAYERS.filter((l) => l.gated === true).every((g) => !r.envelope.excluded.some((e) => e.id === g.id)),
    JSON.stringify(r.envelope.excluded.map((e) => e.id)));
  const settings = assemble(
    layersOf().filter((l) => !['scene', 'blueprint', 'story_tail'].includes(l.id)),
    { mode: 'settings', workId: 7 });
  const skipped = settings.envelope.excluded.filter((e) => e.reason.includes('settings'));
  ok('settings 模式下被跳过的层，原因写明"按层规格跳过"（不是"数据缺失"）',
    skipped.length >= 1, JSON.stringify(skipped.map((e) => e.id)));
}

console.log('\n【3. 完整性：正常输入必须 PASS】');
{
  ok('干净装配 → PASS', r.integrity.status === 'PASS', JSON.stringify(r.integrity.checks.filter((c) => !c.ok)));
  ok('PASS 时所有检查项都真的跑了（不是空表）', r.integrity.checks.length >= 8, `检查项 ${r.integrity.checks.length}`);
  ok('估算 token 存在，且标注为估算', Number.isFinite(r.stats.estimatedTokens) && r.stats.estimatedTokens > 0
    && /估算/.test(r.stats.tokenEstimateNote || ''));
}

console.log('\n【4. 阴性对照（变异测试）：每一项都必须能被破坏性输入判失败】');
{
  // C1 / C6：清单与文字不一致（把文字改掉一个字）
  const tampered = { ...r, text: r.text + 'X' };
  const v1 = verifyContextIntegrity({ text: tampered.text, manifest: r.manifest, overflow: r.overflow, budget: r.stats.budget, contextId: r.contextId });
  ok('文字被改写 → FAIL（C1 清单与文字不一致）', v1.status === 'FAIL' && v1.failed.includes('C1'), JSON.stringify(v1.failed));
  ok('文字被改写 → FAIL（C6 内容哈希不符）', v1.failed.includes('C6'));

  // C2：某层超过自己的 cap
  const overCap = r.manifest.map((m) => m.id === 'work' ? { ...m, emitted: (Number(m.declaredCap) || 0) + 1 } : m);
  const v2 = verifyContextIntegrity({ text: r.text, manifest: overCap, overflow: null, budget: 1e9 });
  ok('某层超过 cap → FAIL（C2）', v2.status === 'FAIL' && v2.failed.includes('C2'), JSON.stringify(v2.failed));

  // C3：零损失层**被总预算收缩**（真正的契约违反，I3）
  const shrunkFixed = r.manifest.map((m) => m.id === 'memory' ? { ...m, dropped: 10, truncated: true, shrunk: true } : m);
  const v3 = verifyContextIntegrity({ text: r.text, manifest: shrunkFixed, overflow: null, budget: 1e9 });
  ok('零损失层被总预算收缩 → FAIL（C3）', v3.failed.includes('C3'), JSON.stringify(v3.failed));

  // C3 的**阳性对照**（这一条是被真实数据教出来的）：零损失层超过**自己的 cap** 时按 cap 截断，
  // 这是既有行为、也是可查回的，**不得**被判成 FAIL——第一版判据正是在这里误报。
  const capCut = r.manifest.map((m) => m.id === 'memory'
    ? { ...m, dropped: 500, truncated: true, shrunk: false, recoveryPath: { tool: 'novel_memory_read', intrinsic: false } }
    : m);
  const v3b = verifyContextIntegrity({ text: r.text, manifest: capCut, overflow: null, budget: 1e9 });
  ok('零损失层超过自身 cap 被截断（未参与收缩）→ 不判 FAIL',
    !v3b.failed.includes('C3'), JSON.stringify(v3b.failed));

  // C8：有内容被丢掉却没标记为截断（静默裁剪）
  const silent = r.manifest.map((m) => m.id === 'outline' ? { ...m, dropped: 50, truncated: false } : m);
  const v8 = verifyContextIntegrity({ text: r.text, manifest: silent, overflow: null, budget: 1e9 });
  ok('静默裁剪（丢了字却没标截断）→ FAIL（C8）', v8.failed.includes('C8'), JSON.stringify(v8.failed));

  // C4：超预算的两种形态
  const vF = verifyContextIntegrity({ text: r.text, manifest: r.manifest, overflow: null, budget: 10 });
  ok('超预算且**没有**标记 → FAIL（C4，静默超限）', vF.failed.includes('C4'), JSON.stringify(vF.failed));
  const vW = verifyContextIntegrity({ text: r.text, manifest: r.manifest, overflow: { reason: '压到下限仍超' }, budget: 10 });
  ok('超预算但**有**显式标记 → 不是 FAIL（降为 WARNING，契约 I1）',
    vW.status === 'WARNING' && !vW.failed.includes('C4'), JSON.stringify({ s: vW.status, w: vW.warned }));

  // C5：被裁层没有查回路径
  // C5 的阴性 + 阳性对照：真实数据里每个被裁层都带 recoveryPath（工具名来自 RETRIEVAL），
  // 第一版判据读错了字段名（recovery_path vs recoveryPath）→ 全量误报。这里两条都钉住。
  const withPath = r.manifest.map((m) => m.id === 'outline' ? { ...m, truncated: true, dropped: 5, recoveryPath: { tool: 'novel_lookup', intrinsic: false } } : m);
  const v5ok = verifyContextIntegrity({ text: r.text, manifest: withPath, overflow: null, budget: 1e9 });
  ok('被裁层**有**查回路径时不误报（字段名对得上）', !v5ok.warned.includes('C5'), JSON.stringify(v5ok.warned));
  const noPath = r.manifest.map((m) => m.id === 'outline' ? { ...m, truncated: true, dropped: 5, recoveryPath: { tool: '', intrinsic: false } } : m);
  const v5 = verifyContextIntegrity({ text: r.text, manifest: noPath, overflow: null, budget: 1e9 });
  ok('被裁层没有查回路径 → WARNING（C5，已知缺口要一直看得见）',
    v5.status === 'WARNING' && v5.warned.includes('C5'), JSON.stringify({ s: v5.status, w: v5.warned }));

  // C7：某层没有溯源声明
  const noSource = r.manifest.map((m) => m.id === 'memory' ? { ...m, source: '' } : m);
  const v7 = verifyContextIntegrity({ text: r.text, manifest: noSource, overflow: null, budget: 1e9 });
  ok('某层没有溯源 → WARNING（C7）', v7.warned.includes('C7'), JSON.stringify(v7.warned));
}

console.log('\n【5. 溯源表与层规格同源（不许各写一份）】');
{
  ok(`PROVENANCE 覆盖全部 ${LAYERS.length} 层`, LAYERS.every((l) => !!PROVENANCE[l.id]),
    LAYERS.filter((l) => !PROVENANCE[l.id]).map((l) => l.id).join(','));
  ok('PROVENANCE 里没有多余的层（防"改了层 id 忘了改溯源"）',
    Object.keys(PROVENANCE).every((id) => LAYERS.some((l) => l.id === id)),
    Object.keys(PROVENANCE).filter((id) => !LAYERS.some((l) => l.id === id)).join(','));
  ok('凡参与收缩的层都声明了 floor（与 FLEX_ORDER 一致）',
    LAYERS.filter((l) => trimPriorityOf(l.id) !== null && trimPriorityOf(l.id) !== 'never').every((l) => Number.isFinite(l.floor)));
  ok('溯源里的查回路径与 RETRIEVAL 同源（清单里的 recoveryPath 不是另编的）',
    LAYERS.every((l) => {
      const row = r.manifest.find((m) => m.id === l.id);
      if (!row) return true;
      const decl = RETRIEVAL[l.id];
      if (!decl) return row.recoveryPath === null;
      return row.recoveryPath && row.recoveryPath.tool === (decl.tool || '') && row.recoveryPath.intrinsic === (decl.intrinsic === true);
    }));
}

console.log('\n【6. 接线：token 估算不得参与任何决策（预算一律以字符核算）】');
{
  const asm = fs.readFileSync('ai/context/assembler.mjs', 'utf8');
  const code = asm.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('收敛循环仍然按字符比较（joined.length > budget）', /joined\.length\s*>\s*budget/.test(code));
  const tokenUses = (code.match(/estimateTokens\(/g) || []).length;
  ok(`estimateTokens 只出现在"写清单/写统计"两处（实际 ${tokenUses} 处）`, tokenUses <= 2, `出现 ${tokenUses} 次`);
  ok('预算常数仍是字符口径（TOTAL_BUDGET 未被换成 token）', !/budget\s*=\s*[^;]*estimatedTokens/.test(code));
  ok('短文本估算不假装有精度（<100 直接返回原值）', estimateTokens('你好') === 2, String(estimateTokens('你好')));
  // 估算实现从"逐字符正则"改成"数值区段"（为了不拖慢冷路径）。结果必须**逐例相同**，
  // 否则"只是优化"就会悄悄改变清单里的数字。
  {
    const CJK = /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
    const ref = (t) => { const s = String(t || ''); let c = 0; for (const ch of s) if (CJK.test(ch)) c++; return Math.ceil(c + (s.length - c) / 4); };
    const pool = ['你', '好', 'a', 'Z', '1', '，', '。', 'Ａ', '한', 'あ', 'ア', '⺀', '\u3000', '𝄞', ' ', '\n'];
    let seed = 20260924;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let diff = 0;
    for (let i = 0; i < 5000; i++) {
      let s = '';
      const n = Math.floor(rnd() * 24);
      for (let j = 0; j < n; j++) s += pool[Math.floor(rnd() * pool.length)];
      if (ref(s) !== estimateTokensDetailed(s).tokens) diff++;
    }
    ok('估算实现与"逐字符正则"参照逐例一致（5000 例）', diff === 0, `差异 ${diff} 例`);
  }
  ok('内容哈希稳定（同输入同输出）', shortHash('abc') === shortHash('abc') && shortHash('abc') !== shortHash('abd'));
}

console.log('\n【7. 接线：server.js 真的把溯源与完整性接上了】');
{
  const src = fs.readFileSync('server.js', 'utf8');
  ok('buildNovelContext 把 work/chapter/request 身份传给装配器', /requestId:\s*contextOpts\.requestId \|\| newContextRequestId\(\)/.test(src));
  ok('每层的 sourceIds 来自真实取数（不是空数组占位）',
    /sourceIds: shownChapterIds/.test(src) && /sourceIds: events\.map\(\(e\) => e\.id\)/.test(src)
    && /sourceIds: sceneIdList/.test(src));
  ok('语义召回层带上命中文件的 uri 与分数分布',
    /sourceIds: \(semanticRecall\.hits \|\| \[\]\)\.map\(\(h\) => h\.uri\)/.test(src) && /scores: recallScores/.test(src));
  ok('完整性非 PASS 时留下可归因日志（响亮，不静默）', /kind: 'context_integrity'/.test(src));
  ok('响应里下发身份 / 完整性 / 信封',
    /context_id: contextEnvelope\.contextId/.test(src) && /context_integrity: contextIntegrity/.test(src)
    && /context_envelope: contextEnvelope/.test(src));
  ok('主成文路径（ai_context）同样下发（与创作内核同源）',
    /context_integrity: budgeted \? budgeted\.context_integrity : null/.test(src));
}

console.log(`\n══════════════════════════════`);
console.log(`上下文清单/完整性离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;