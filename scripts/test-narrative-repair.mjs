#!/usr/bin/env node
/**
 * test-narrative-repair.mjs —— 《叙事性专项修复》专项套件的**总入口**（零依赖、零计费）。
 *
 * 纪律（与 scripts/test-temporal-refactor.mjs 一致）：
 *   · 显式清单，不用跨平台不一致的 shell glob；
 *   · 每个子套件以子进程执行，只信退出码；失败继续跑完，最后一次看清全部红灯；
 *   · 清单为空、或 `--only` 匹配到零个用例 → **非零退出**（不许把"没找到测试"当成功）；
 *   · 不连真实模型、不读生产密钥、不触碰真实作品数据（只读 tests/narrative-repair/fixtures）。
 *
 * 用法：node scripts/test-narrative-repair.mjs [--only 01]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 显式清单：新增叙事专项套件必须登记在这里（并同步进 scripts/ci-offline-checks.mjs）。 */
export const NARRATIVE_REPAIR_TESTS = [
  // P 类：局部补丁协议 v2（P01—P09、P14 的模块级判定面）
  'tests/narrative-repair/01-patch-protocol.test.mjs',
  // R 类：冻结样本与来源标签（R01 / R12）
  'tests/narrative-repair/02-fixtures.test.mjs',
  // E02：阶段化规则编译（同一能力在不同阶段注入不同内容；审计摘要可核对）
  'tests/narrative-repair/03-stage-rules.test.mjs',
  // E04：叙事诊断的确定性候选层 + 审稿协议层（引用核验 / 反证要求 / 保护分区；正例与阴性对照）
  'tests/narrative-repair/04-narrative-scan.test.mjs',
  // E05：受约束的局部编辑计划（热点/授权跨度/不变量/依赖组/预算；不自动扩大、勾选变更即作废）
  'tests/narrative-repair/05-revision-plan.test.mjs',
  // E06：可解释报告的确定性部分（单独撤销 / 相对结论必须先读 diff / 开关默认关闭）
  'tests/narrative-repair/06-report.test.mjs',
  // E03：审稿报告结构化与引用核验（逐字定位 / 重复引用拒收 / 反证降级 / 旧口径不变）
  'tests/narrative-repair/07-review-structure.test.mjs',
  // E01（116 轮）：锁死"选中问题 → 获准跨度 → 实际补丁"（授权表 / 歧义拒绝 / plan 不放宽 / legacy 隔离）
  'tests/narrative-repair/08-authorization.test.mjs',
  // E03（116 轮）：解决"删得掉，但删错信息"（A01 information_truncation / A02 合理精简 / 阴性对照）
  'tests/narrative-repair/09-information-truncation.test.mjs',
  // E04/E06（116 轮）：新一组「3751年，春」夹具 + 四类叙事诊断的正反对照
  'tests/narrative-repair/10-new-sample.test.mjs',
  // E01/§5.1-5.3 + §6.3（116 轮·第二轮）：扫描命中候选化、报告自洽、感知/因果候选、
  // 缺授权 fail-closed 与篇幅缺口如实呈现。
  'tests/narrative-repair/11-review-closure.test.mjs',
  // 《0731 号觉醒日》增补方案 §3 + T38–T45：概率抽取的边界（100%/123%/0%/极小数）、
  // 稀有度口语不得当等级分布、同等级去重、以及两份实现（public/ 与 ai/editing/）口径一致。
  'tests/narrative-repair/12-percent-claims.test.mjs',
  // 《0731 号觉醒日》增补方案 T31/T32/T34/T35/T36/T37：授权身份稳定（immutable id /
  // selection_hash / 快照可追溯）+ 越权与失效姿态（out_of_scope / ambiguous_anchor /
  // needs_scope / 选中≠授权 / fail-closed）。T33 需改协议 schema，本轮不含。
  'tests/narrative-repair/13-closure-0731.test.mjs',
  // 《0731 号觉醒日》增补方案 §4 + §5 T41/T42/T43：问题解决状态与补丁条数必须分开读
  // （partially_resolved 不得升级成 patched、keep/deferred 不产生改章补丁、空口 patched 记
  // unaccounted）、同校同名的字面重复不得被当成可删的冗余事实。
  'tests/narrative-repair/14-plan-coverage-0731.test.mjs',
  // 《0731 号觉醒日》增补方案 §2 P0-A 末条 + §5 T33：补丁理由与它声称处理的问题必须对得上。
  // 协议 v2 的 patch 载荷新增可选 reason 字段；理由显式引用别的 issue 编号时标为
  // reason_unverified（不得渲染成可信理由），但不阻断补丁本身（理由错配 ≠ 改错地方）。
  'tests/narrative-repair/15-reason-binding.test.mjs',
  // 《0731 号觉醒日》增补方案 §2 P0-B：第三重授权（op 必须在授权 ops 内）+ 零宽 insert（R07）。
  // 与 08-authorization 的分工：08 管"跨度有没有被授权"，本套管"这种改法有没有被授权"。
  'tests/narrative-repair/16-op-authorization.test.mjs',
  // 《Novel Studio v1.1.8｜3月17日觉醒日》专项增补 §7：V118-01～V118-15。
  // 未经批准的制度/时间机制候选（new_workflow_rule / temporal_causal_bridge）、审稿报告引文的
  // 归属核验（quote_not_found）、strengths 绝对局限措辞的限定建议、同物件状态跨句桥接候选、
  // 未选中问题不得假称已改、缺语义核验不得报 resolved、伏笔编号锚可见性、常见等级结果的因果候选。
  'tests/narrative-repair/17-review-closure-0317.test.mjs',
  // 《六项审稿漏修与语义闭环》方案 §11：N01–N36（六项夹具 + 判据/复修/终验/工作区同一口径）。
  // 覆盖"只修半个问题、完全漏修、改错位置、跨角色卡未核验"四类伪修复，以及
  // 已 PASS 项不被后续复修冲掉、单段/分段同一出口、分母不缩。
  'tests/narrative-repair/18-six-issue-closure.test.mjs',
  // 《逐项验收卡死》2026-10-22：V00–V39（复修入口 / 轮次预算守卫 / 剩余证据扩范围 /
  // 已知遗留 / 复验额度按候选版本）。这套断言直接管"判了局部之后还有没有下一步"。
  'tests/narrative-repair/19-partial-repair-entry.test.mjs',
  // 2026-10-23 本轮审稿回放（A01–A37）：9 条问题逐条终态 / 改错位置 / 部分子条件 /
  // 底稿 hash / 工作区显示 / 报告"优点需加限定"的无关反例筛选 / 审稿底本指纹（A30–A37）。
  'tests/narrative-repair/20-review-round-20261023.test.mjs',
];

const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
if (!NARRATIVE_REPAIR_TESTS.length) {
  console.error('✗ 叙事专项测试清单为空：拒绝把"没有测试"当作通过。');
  process.exit(2);
}
const list = only ? NARRATIVE_REPAIR_TESTS.filter((f) => f.includes(only)) : NARRATIVE_REPAIR_TESTS;
if (!list.length) {
  console.error(`✗ --only ${only} 没有匹配任何叙事专项测试。`);
  process.exit(2);
}

const results = [];
/**
 * 受限沙箱里 `spawnSync` + `stdio:'pipe'` 会被拒绝（子进程 status=null，套件耗时≈0ms）。
 * 那**不是测试失败**，但我们也不能把"起不来"记成通过 —— 因此退到**同进程**执行：
 * 仍然逐套件跑真实断言、仍然按退出码判定，只是不再要一根管道。
 * 运行环境允许管道时走原来的子进程路径（隔离更好，且与仓库其他运行器一致）。
 */
async function runInProcess(rel) {
  const { pathToFileURL } = await import('node:url');
  const orig = { log: console.log, error: console.error };
  const buf = [];
  const cap = (...a) => { buf.push(a.map((x) => String(x)).join(' ')); };
  console.log = cap;
  console.error = cap;
  const prevExit = process.exitCode;
  process.exitCode = 0;
  let threw = '';
  try {
    await import(`${pathToFileURL(path.join(REPO, rel)).href}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  } catch (e) {
    threw = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e);
    process.exitCode = 1;
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  const status = process.exitCode || 0;
  process.exitCode = prevExit || 0;
  return { stdout: buf.join('\n'), stderr: threw, status };
}

let inProcessFallback = false;
for (const rel of list) {
  const t0 = Date.now();
  let r = spawnSync(process.execPath, [rel], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status === null && !String(r.stdout || '').trim() && !String(r.stderr || '').trim()) {
    if (!inProcessFallback) {
      inProcessFallback = true;
      console.log('提示：当前环境不允许子进程管道（spawnSync status=null）→ 改用**同进程**逐套件执行（断言与退出码判定不变）。\n');
    }
    r = await runInProcess(rel);
  }
  const ms = Date.now() - t0;
  const out = String(r.stdout || '');
  const summary = (out.split(/\r?\n/).filter((l) => l.includes('通过') && l.includes('未通过')).pop() || '').trim();
  const ok = r.status === 0;
  results.push({ rel, ok, ms, summary });
  console.log(`${ok ? '✓' : '✗'} ${rel}（${ms}ms）${summary ? ` ${summary}` : ''}`);
  if (!ok) {
    out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).slice(0, 10).forEach((l) => console.log(`    └ ${l.trim()}`));
    const err = String(r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' | ');
    if (err) console.log(`    └ stderr: ${err.slice(0, 300)}`);
  }
}
const bad = results.filter((r) => !r.ok);
console.log(`\n合计：通过 ${results.length - bad.length} / 未通过 ${bad.length}（共 ${results.length} 个套件，零计费）`);
if (bad.length) console.log('未通过：' + bad.map((b) => b.rel).join('; '));
process.exitCode = bad.length ? 1 : 0;
