#!/usr/bin/env node
/**
 * 上下文契约的机读规格 + 可执行下限自动核算（P1 冻结快照）。
 *
 * ⚠️ 这是 **P1 冻结的现状快照**，规格是从 server.js 的 buildNovelContext 抄录的，
 *    目的是让「契约」可以被机器核算、被后续改动对照。P2 重建装配器后，规格应改为
 *    **由装配器自身导出**（单一来源），本文件届时退化为对照基线。
 *
 * 为什么要核算「可执行下限」而不只写「总预算」：
 *   历史失误 1 —— settings 模式总预算曾设 12,000 字，但质量层 cap 合计已超过它，
 *   收敛循环永远压不到目标，常量误导。规则：凡设预算常量，先算可执行下限。
 *
 * 用法：
 *   node context-floor.mjs            # 打印各模式的下限核算
 *   node context-floor.mjs --json     # 输出机读结果
 */

// ── 层规格（抄录自 server.js:1757-1773，P1 冻结）────────────────────────────
// kind: 'fixed'   不参与收缩（零损失承诺的内容本身）
//       'flex'    参与收缩，floor 为其收缩下限
//       'cond'    条件层，数据缺失时整层不存在（下限按「存在」计）
//       'entity'  层上限为 Infinity，真实边界由其构建函数决定（见 actualCap）
const LAYERS = [
  { label: '作品',                             cap: 900,    kind: 'fixed',  source: 'works.title/description + workConfigText' },
  { label: '卷/剧情线/章节进度（大纲）',        cap: 2800,   kind: 'flex',   floor: 400, source: 'volumes + plotlines + chapters(title/summary)' },
  { label: '长期记忆（已发生的故事摘要）',      cap: 2200,   kind: 'fixed',  source: 'story_memories（版本化）' },
  { label: '相关记忆检索（语义召回）',          cap: 1400,   kind: 'cond',   source: 'OpenViking find（top-8 / 阈值 0.3 / 每段截 300 字）' },
  { label: '最近事件（事件账本）',              cap: 1800,   kind: 'fixed',  source: 'story_events 近 30 条 × 每条 200 字' },
  { label: '未闭合伏笔（写作时必须照顾）',      cap: 1200,   kind: 'fixed',  source: 'story_events kind=foreshadow 未回收 ≤20 × 160 字' },
  { label: '当前场景',                          cap: 1200,   kind: 'cond',   source: 'chapters（position/title/summary/author_note）' },
  { label: '本章蓝图（写作必须遵守）',          cap: 1500,   kind: 'cond',   source: 'chapters.blueprint_json（5 字段各截 600 字）' },
  { label: '前文衔接',                          cap: 1600,   capContinuation: 4000, kind: 'flex', floor: 400, source: 'chapters.content 尾部' },
  { label: '出场角色卡',                        cap: Infinity, kind: 'entity', actualCap: 4000, actualCapNote: 'buildCharacterCards(chars, 4000) 5 级降级 + 兜底提示语 ≈28 字',
                                                source: 'characters（评分制选 ≤16）' },
  { label: '人物关系',                          cap: 800,    kind: 'cond',   source: 'character_relations（仅出场角色之间）' },
  { label: '激活的世界观设定（优先级排列）',    cap: 3000,   kind: 'flex',   floor: 400, source: 'world_entries（pinned/关键词命中 ≤30 × 每条 600 字）' },
  { label: '写作风格红线',                      cap: 4000,   kind: 'fixed',  source: 'writing_redlines + style_positive' },
];

// 收缩顺序与档位（抄录自 server.js:1784-1785）
const FLEX_LAYERS = ['前文衔接', '卷/剧情线/章节进度（大纲）', '激活的世界观设定（优先级排列）'];
const FLEX_CAPS = [2400, 1600, 800, 400];

// 总预算（抄录自 server.js:1783）
const TOTAL_BUDGET = { settings: 18000, other: 26000 };

/** 每层渲染开销：`【label】\n` */
const headerOf = (label) => `【${label}】\n`.length;
/** 层间分隔符 `\n\n` */
const SEPARATOR = 2;
/** section() 在截断时追加的提示语（server.js:1705），它 **不计入 cap**（已知缺陷） */
const truncationNotice = (originalLen) =>
  `\n…（本层共 ${originalLen} 字，已按预算截断；如需精确内容可用 novel_lookup 查证）`.length;

/**
 * 核算一个模式下的可执行下限。
 * 下限 = 不收缩层的 cap 之和 + 每层渲染开销 + 层间分隔
 *      + 弹性层收缩到 floor 后的正文 + 被截断弹性层的提示语开销。
 */
function computeFloor(mode = 'full') {
  const isSettings = mode === 'settings';
  const present = LAYERS.filter((l) => {
    if (isSettings && ['当前场景', '本章蓝图（写作必须遵守）', '前文衔接'].includes(l.label)) return false;
    return true;
  });

  const headerTotal = present.reduce((n, l) => n + headerOf(l.label), 0);
  const separatorTotal = Math.max(0, present.length - 1) * SEPARATOR;

  let fixedBody = 0;
  let flexFloorBody = 0;
  let noticeTotal = 0;
  const breakdown = [];

  for (const l of present) {
    const bodyCap = l.kind === 'entity' ? l.actualCap : l.cap;
    if (l.kind === 'flex') {
      flexFloorBody += l.floor;
      noticeTotal += truncationNotice(999999); // 收缩到 floor 必然触发截断提示
      breakdown.push({ label: l.label, kind: l.kind, counted: l.floor, note: `收缩下限 ${l.floor}` });
    } else {
      fixedBody += bodyCap;
      breakdown.push({ label: l.label, kind: l.kind, counted: bodyCap, note: l.kind === 'entity' ? '构建函数实际上限' : '不收缩' });
    }
  }

  const floor = headerTotal + separatorTotal + fixedBody + flexFloorBody + noticeTotal;
  return {
    mode,
    totalBudget: isSettings ? TOTAL_BUDGET.settings : TOTAL_BUDGET.other,
    layerCount: present.length,
    headerTotal,
    separatorTotal,
    fixedBody,
    flexFloorBody,
    noticeTotal,
    floor,
    budgetReachable: (isSettings ? TOTAL_BUDGET.settings : TOTAL_BUDGET.other) >= floor,
    breakdown,
  };
}

/** 满配（所有层都顶到 cap）时的总长，用于判断收敛循环是否会被触发。 */
function computeMax() {
  const headerTotal = LAYERS.reduce((n, l) => n + headerOf(l.label), 0);
  const separatorTotal = (LAYERS.length - 1) * SEPARATOR;
  const body = LAYERS.reduce((n, l) => {
    const cap = l.kind === 'entity' ? l.actualCap : (l.capContinuation || l.cap);
    return n + (Number.isFinite(cap) ? cap : 0);
  }, 0);
  const notices = LAYERS.filter((l) => Number.isFinite(l.cap)).length * truncationNotice(999999);
  return { headerTotal, separatorTotal, body, notices, max: headerTotal + separatorTotal + body + notices };
}

function main() {
  const json = process.argv.includes('--json');
  const results = ['full', 'continuation', 'fragment', 'settings'].map(computeFloor);
  const maxInfo = computeMax();

  if (json) {
    console.log(JSON.stringify({ floors: results, maxInfo, layers: LAYERS }, null, 2));
    return;
  }

  console.log('═══ 上下文分层契约：可执行下限核算（P1 冻结快照）═══\n');
  console.log('层规格（cap 为单层上限；flex 层可被收敛循环压缩）：');
  for (const l of LAYERS) {
    const cap = l.kind === 'entity' ? `实体上限 ${l.actualCap}` : (l.capContinuation ? `${l.cap}/${l.capContinuation}(接龙)` : String(l.cap));
    console.log(`  ${l.kind.padEnd(6)} ${String(cap).padStart(18)}  ${l.label}`);
  }
  console.log('\n各模式：');
  for (const r of results) {
    console.log(`\n  [${r.mode}]  总预算 ${r.totalBudget}  层数 ${r.layerCount}`);
    console.log(`    不收缩层正文  ${String(r.fixedBody).padStart(6)}`);
    console.log(`    弹性层收缩下限 ${String(r.flexFloorBody).padStart(6)}`);
    console.log(`    层标题开销    ${String(r.headerTotal).padStart(6)}`);
    console.log(`    层间分隔      ${String(r.separatorTotal).padStart(6)}`);
    console.log(`    截断提示语    ${String(r.noticeTotal).padStart(6)}  （⚠ 不带入 cap 核算，是已知缺陷）`);
    console.log(`    ── 可执行下限 ${String(r.floor).padStart(6)}   预算可达：${r.budgetReachable ? '是' : '否 ✗'}`);
  }
  console.log(`\n满配（所有层顶到 cap）≈ ${maxInfo.max} 字`);
  console.log(`  → ${maxInfo.max > TOTAL_BUDGET.other ? '超过' : '未超过'} full 模式总预算 ${TOTAL_BUDGET.other}，收敛循环${maxInfo.max > TOTAL_BUDGET.other ? '会' : '不会'}被触发`);
}

main();
