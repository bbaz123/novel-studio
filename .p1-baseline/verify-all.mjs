#!/usr/bin/env node
/**
 * 一键验收：把 P0–P6 重构的全部验证跑一遍，输出汇总表。
 *
 * 为什么需要它：这些验证散在十几个工具里，阶段报告各自只跑了其中一部分。
 * 复核者（或未来的我）需要一条命令就能复现「本次重构到底验证了什么、现在是否仍然成立」。
 *
 * 设计原则：
 *   - **区分「未通过」与「跑不了」**：需要活实例/外部仓库的检查在缺前置时标 SKIP，不伪装成 PASS；
 *   - **只信退出码，不信输出文案**：每个检查以子进程退出码为准；
 *   - 汇总表最后一列给出复现命令，便于逐条追查。
 *
 * 用法:
 *   node .p1-baseline/verify-all.mjs                 # 有活实例就跑全量
 *   node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3739 --db .p1-baseline/stress-data/novel.db --work 16 --chapter 227
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { countRealCallsSince } from './audit-llm-calls.mjs';

// 套件起点：用于跑完之后审计「本次到底有没有真的调用 LLM」。
// 2026-09-15 事故的核心问题是**花钱没有信号**；这里把它变成一条红灯。
const SUITE_T0 = Date.now();

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('--base', 'http://127.0.0.1:3739');
const DB = arg('--db', '.p1-baseline/stress-data/novel.db');
const REAL_DB = arg('--real-db', '.p1-baseline/data/novel.db');
const WORK = arg('--work', '16');
const CHAPTER = arg('--chapter', '227');
// 并发闸门检查会真建 harness 作业，必须显式指向 dead-port 隔离实例；
// 不传就 SKIP（而不是偷偷跑到默认 BASE 上花真钱）。
const GATE_BASE = arg('--gate-base', '');

const OK = '通过';
const FAIL = '未通过';
const SKIP = '跳过';

const results = [];

/** 从输出里挑一行**最能说明结论**的作为证据，而不是无脑取最后一行。 */
const VERDICT_RE = /结论[:：]|合计[:：]|结果[:：]|逐字节一致|绕过策略|版本一致|I4 成立|全部通过|全部成立|失败项|未通过|违反|推导=/;
function pickEvidence(out) {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    // 剔除噪音行：日志前缀、git 的 CRLF 警告——它们会**顶掉真正的结论**
    //（实测：阶段映射那条的证据行曾被 "warning: in the working copy of 'server.js'..." 占掉）。
    .filter((l) => l && !l.startsWith('[logger:') && !/^warning:/i.test(l) && !/^注意[:：]/.test(l));
  const verdict = lines.filter((l) => VERDICT_RE.test(l));
  return (verdict.slice(-1)[0] || lines.slice(-1)[0] || '').slice(0, 96);
}

/** 跑一条命令，只取退出码；输出里挑一行结论作为证据。 */
function run(label, cmd, args, { cwd = process.cwd(), requires, skipReason } = {}) {
  if (requires && !requires()) {
    results.push({ label, status: SKIP, evidence: skipReason || '前置不满足', cmd: `${cmd} ${args.join(' ')}` });
    return;
  }
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600000 });
  results.push({
    label,
    status: r.status === 0 ? OK : FAIL,
    evidence: pickEvidence(`${r.stdout || ''}${r.stderr || ''}`),
    cmd: `${cmd} ${args.join(' ')}`,
  });
}

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok || r.status < 500;
  } catch { return false; }
}
const hasBase = await reachable(`${BASE}/api/works`);

/**
 * 目录里是否**真的有可比较的用例**。
 * 为什么要这一条：逐用例基线 JSON 被 `.p1-baseline/.gitignore` 排除（可由 capture-baseline.mjs 重抓），
 * 所以**新克隆的仓库里这些目录是空的**。空目录下比较器会报"0/0 一致"——
 * 三个比较器已改成空输入直接失败（exit 2），套件据此把它标成**跳过**而不是通过，
 * 这样"跑不了"与"未通过"仍是两件事。
 */
const hasCases = (dir) =>
  fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.json') && f !== 'summary.json');
const NO_CASES_HINT = '逐用例基线 JSON 被 .gitignore 排除（可由 capture-baseline.mjs 重抓）；'
  + '空目录比较等于没比、工具会直接失败，故这里标跳过';

// ── 1. 语法 ─────────────────────────────────────────────────────────────
// 清单**从实际源码派生**，不再手写枚举。手写清单会腐烂：`ai/harness-env.mjs` 与
// `ai/edit-distance.mjs` 加进仓库后一直**没被检查过**（手写 50 个 vs 实际 65 个）——
// 与阶段映射要解决的问题同源：清单必须从被检查的对象派生。
// 但"派生"必须自带护栏：排除规则一旦写宽，就会静默漏掉源码而仍然报绿，
// 所以下面钉一份**代表性文件清单**，缺任何一个即判失败。
{
  const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'data']);
  const EXCLUDE_PREFIXES = [
    '.test-data-',
    '.p1-baseline/data', '.p1-baseline/stress-data', '.p1-baseline/gate-data', '.p1-baseline/suite-data',
    '.p0-recon/scratch-data', '.p0-recon/head-snapshot',
    '.p6-cutover/.rehearsal', '.p6-cutover/.verify', '.p6-cutover/.negctl',
  ];
  const CODE_EXT = /\.(mjs|cjs|js)$/;
  const walk = (dir, acc) => {
    const base = dir || '.';
    for (const name of fs.readdirSync(base)) {
      const rel = dir ? `${dir}/${name}` : name;
      if (EXCLUDE_DIRS.has(name)) continue;
      if (EXCLUDE_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
      if (fs.statSync(rel).isDirectory()) { walk(rel, acc); continue; }
      if (CODE_EXT.test(name)) acc.push(rel.replace(/\\/g, '/'));
    }
    return acc;
  };
  const files = walk('', []).sort();
  // 护栏：这些必须出现在清单里（防排除过宽）。含本轮之前被漏检的两个模块。
  const MUST_INCLUDE = [
    'server.js', 'harness.js', 'db.js', 'public/app.js',
    'ai/policy.mjs', 'ai/context/layers.mjs', 'ai/context/assembler.mjs',
    'ai/harness-env.mjs', 'ai/edit-distance.mjs',
    'harness-plugins/novel-writing/novel-tools.mjs',
    'harness-plugins/novel-writing/test/smoke.mjs',
    'api-test-suite.mjs', 'frontend-test.mjs',
    '.p0-recon/verify-harness-profile.mjs', '.p1-baseline/verify-all.mjs', '.p6-cutover/cutover.mjs',
  ];
  const missing = MUST_INCLUDE.filter((f) => !files.includes(f));

  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(f);
  }
  const okAll = !bad.length && !missing.length;
  results.push({
    label: `语法检查（派生清单 ${files.length} 个文件）`,
    status: okAll ? OK : FAIL,
    evidence: bad.length
      ? `语法失败: ${bad.slice(0, 3).join(', ')}`
      : (missing.length ? `清单护栏失败：漏掉 ${missing.join(', ')}（排除规则写宽了？）` : `全部通过（含护栏 ${MUST_INCLUDE.length} 项）`),
    cmd: 'node --check <派生清单>',
  });
}

// ── 2. 契约不变量（离线）───────────────────────────────────────────────
for (const [dir, name] of [['.p1-baseline/baselines-p5', '压力'], ['.p1-baseline/baselines-p5-real', '真实']]) {
  run(`契约不变量 I1/I2/I3/I7（${name}数据）`, process.execPath, ['.p1-baseline/verify-invariants.mjs', dir],
    { requires: () => hasCases(dir), skipReason: NO_CASES_HINT });
}

// ── 3. 装配回归（离线）─────────────────────────────────────────────────
// 真实：与 P1 参照逐字节一致（--ignore-notice 归一截断提示文本）。
run('装配回归：P1 基线 vs 当前（真实）', process.execPath,
  ['.p1-baseline/compare-baseline.mjs', '.p1-baseline/baselines-p3-real', '.p1-baseline/baselines-p5-real', '--ignore-notice'],
  { requires: () => hasCases('.p1-baseline/baselines-p5-real') && hasCases('.p1-baseline/baselines-p3-real'),
    skipReason: NO_CASES_HINT });

// 压力：自审 F6 修掉「压缩提示被自己截掉」后，**差异不再为零**——但也不该"随便怎么变都行"。
// 所以判据换成更强的一条：差异必须**恰好**是提示从末尾挪到开头（含代价量化）。
// 参照用本次修复的**直接前驱** baselines-pre-hint，而不是 P3 时代的 baselines-p3：
// 后者与当前之间还叠着提示语文本的差异（那正是当初要 --ignore-notice 的原因）。
run('装配回归：差异须恰好为已刻画的「压缩提示挪位」（压力）', process.execPath,
  ['.p1-baseline/compare-memory-hint.mjs', '.p1-baseline/baselines-pre-hint', '.p1-baseline/baselines-p5'],
  { requires: () => hasCases('.p1-baseline/baselines-pre-hint') && hasCases('.p1-baseline/baselines-p5'),
    skipReason: NO_CASES_HINT });

// ── 4. 策略与工具面（离线）─────────────────────────────────────────────
run('装配器单元测试（边界与溢出分支）', process.execPath, ['.p1-baseline/test-assembler.mjs']);
run('AI 全分支核对（0 处绕过策略）', process.execPath, ['.p1-baseline/verify-ai-branches.mjs']);
// 2026-09-18：质量档统一为 V4.1 Flash、质量改由思考强度表达、长任务超时单点化
// —— 三件事都属于"悄悄失效也不会报错"的类型（两档模型不一致 / 强度补偿丢失 / 超时被 clamp 截短）。
run('模型档位·强度补偿·长任务超时（策略单点）', process.execPath, ['.p1-baseline/test-policy-tiers.mjs']);
// ⚠️ 这两条此前**只在 MUST_INCLUDE 里出现**（只被 `node --check` 语法检查扫过，从不被执行）——
// 于是本轮新增的前端断言与配置链断言不在任何"一键验收"里，README 的
// 「一键跑完全部验证」也就成了过度声明。两者都零网络、零服务器、零计费，默认跑。
run('前端执行验证（vm + DOM 桩：渲染/交互/回归断言）', process.execPath, ['frontend-test.mjs']);
run('工具与环境配置链（OpenViking 凭证 / dsh 仓库 / 全局写入）', process.execPath, ['env-tools-test.mjs']);
run('插件工具面与版本一致', process.execPath, ['.p1-baseline/verify-plugin-tools.mjs']);
// 编码类缺陷定点检查（2026-09-18 扩了两处覆盖）：
//   A 非法 UTF-8（git 按字节存，不会报错）；B **含非 ASCII 的 .ps1 必须带 BOM**
//   ——PS 5.1 把无 BOM 文件按 ANSI 读，中文会吞掉后续 ASCII 字节，脚本静默变成语法错误。
//   之前的扫描连 .ps1 都不在扩展名表里，所以没拦住本轮的 install.ps1 BOM 丢失。
run('编码检查（非法 UTF-8 + .ps1 的 BOM 约定）', process.execPath, ['.p1-baseline/check-utf8.mjs']);
run('编码检查判据自检（含阴性对照）', process.execPath, ['.p1-baseline/check-utf8.mjs', '--self-test']);
// D8-#3 续：**模型自压缩**也走零损失护栏（判据真值表 + 变异体对照 + 跨模块字面量契约）
run('模型自压缩的零损失护栏', process.execPath, ['.p1-baseline/test-agent-memory-guard.mjs']);
// D8-#5：召回层不可用时不得静默消失（缺口判据真值表 + 变异体阴性对照 + 三处接线同源）
run('召回缺口不得静默（占位层与端点同源）', process.execPath, ['.p1-baseline/test-recall-gap.mjs']);
// D8-#6：「建完立刻删」不得留下孤儿记忆目录（真实时序 + 摘掉闸门的阴性对照）
run('同步闸门（在途同步 vs 移除的竞态）', process.execPath, ['.p1-baseline/test-sync-gate.mjs']);
// D8-#7：上下文缓存按"输入有没有变"失效，而不是靠时间猜（含修复前行为的阴性对照）
run('上下文缓存按外部状态失效', process.execPath, ['.p1-baseline/test-context-cache.mjs']);
// D8-#1：回滚矩阵工具**自检**（快、不碰仓库）。全矩阵要创建临时 worktree，
// 属于人工取证的量级，需要时手动跑：node .p1-baseline/revert-matrix.mjs
run('回滚矩阵工具自检（认得出冲突才算可用）', process.execPath,
  ['.p1-baseline/revert-matrix.mjs', '--self-test']);
// D8-#2：每任务独立 settings（补丁内容 + 参数顺序 + 回退路径接线）
run('每任务独立 settings（吞吐回到 2 的前提）', process.execPath,
  ['.p1-baseline/test-task-settings.mjs']);

// ── 4b. I4 的**静态**保证：可截断层必须真有查回路径（零成本，默认跑）────────
// 端到端那条（verify-retrieval）是数据相关的：只查"当前数据里实际被裁的层"。
// 新增层忘了声明、或工具被改名，它都不会报——这条静态核对补的就是这个洞。
run('查回路径静态核对（每层声明 + 工具真实存在）', process.execPath,
  ['.p1-baseline/verify-retrieval-map.mjs']);

// ── 4c. 层规格常量的**单点来源**（零成本，默认跑）──────────────────────
// `entityCap` 曾在 server.js 里被抄了两份（调用处 + 函数默认值），
// 规格里只留一句"改动时要同步"的注释、没有任何检查。这条定点钉住已知的跨模块耦合。
run('层规格常量单点核对（entityCap / continuation 上限）', process.execPath,
  ['.p1-baseline/verify-layer-constants.mjs']);

// ── 前端视图路由一致性（静态）───────────────────────────────────────────
// 抓的是一类真实发生过的 bug：调用 goView('ai-board')，而 'ai-board' 并不在
// SETTINGS_VIEWS / AI_VIEWS / HOME_AI_VIEWS 里——它只是靠 goView 的通用 fallback
// 「碰巧」把 view 设对，在「未进入作品」的场景下就会切到一个无作品可渲染的板块。
{
  const appPath = 'public/app.js';
  if (!fs.existsSync(appPath)) {
    results.push({ label: '前端视图路由一致', status: SKIP, evidence: '找不到 public/app.js', cmd: '' });
  } else {
    const raw = fs.readFileSync(appPath, 'utf8');
    // 必须**先去掉整行注释**再扫描：注释里常常引用错误写法作为反面教材
    // （本文件 8677-8679 行就写了 goView('ai-board') 作反例），
    // 不剥注释会把反例当成真实调用 → 假报。
    const src = raw.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    const listOf = (name) => {
      const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
      return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    };
    // 合法**输入**只有这三张路由表。
    // ⚠️ 不能把 `state.view = 'xxx'` 也算进来——那是 goView 的**输出**：
    // goView 内部就有 `state.view = 'ai-board'` 一行，早先把它当作合法输入，
    // 于是 goView('ai-board') 这个错误写法被判为合法，检查形同虚设（阴性对照抓到的）。
    const known = new Set([...listOf('SETTINGS_VIEWS'), ...listOf('AI_VIEWS'), ...listOf('HOME_AI_VIEWS')]);
    const called = [...new Set([...src.matchAll(/goView\('([^']+)'\)/g)].map((m) => m[1]))];
    const unknown = called.filter((v) => !known.has(v));
    results.push({
      label: '前端视图路由一致（goView 的视图名都有定义）',
      status: unknown.length ? FAIL : OK,
      evidence: unknown.length
        ? `未在 SETTINGS_VIEWS/AI_VIEWS/HOME_AI_VIEWS 中: ${unknown.join(', ')}`
        : `${called.length} 个视图名均有定义`,
      cmd: `grep -n "goView('" public/app.js`,
    });
  }
}

// ── 文档数字与活规格一致（静态）─────────────────────────────────────────
// 抓的是「文档里写死的数字随代码漂移」这一类问题——行号漂移已经害过一次
// （契约文档 25 处 server.js:行号在重构后集体失效）。数字同样会漂：
// 只要有人改一个 cap，可执行下限就变，而文档不会自己跟着变。
{
  const docPath = 'docs/context-contract.md';
  if (!fs.existsSync(docPath)) {
    results.push({ label: '契约文档数字与活规格一致', status: SKIP, evidence: `找不到 ${docPath}`, cmd: '' });
  } else {
    const { computeFloor } = await import('../ai/context/layers.mjs');
    const want = { full: computeFloor('full').floor, settings: computeFloor('settings').floor };
    const doc = fs.readFileSync(docPath, 'utf8');
    const missing = Object.entries(want).filter(([, v]) => !doc.includes(v.toLocaleString('en-US')));
    results.push({
      label: '契约文档数字与活规格一致（可执行下限）',
      status: missing.length ? FAIL : OK,
      evidence: missing.length
        ? `文档里找不到活规格的下限：${missing.map(([k, v]) => `${k}=${v.toLocaleString('en-US')}`).join(', ')}`
        : `full=${want.full.toLocaleString('en-US')} / settings=${want.settings.toLocaleString('en-US')} 均在文档中`,
      cmd: 'node .p1-baseline/context-floor.mjs && grep 20,547 docs/context-contract.md',
    });
  }
}

// ── 5. I4 端到端可查回（需活实例）──────────────────────────────────────
run('I4 端到端可查回（被裁层逐个实调端点）', process.execPath,
  ['.p1-baseline/verify-retrieval.mjs', BASE, DB, WORK, CHAPTER],
  { requires: () => hasBase && fs.existsSync(DB) });

// ── 5b. 质量信号哨兵（需活实例；只读 GET，零计费）───────────────────────
// 它衡量"你改了多少"（采纳率/编辑距离/体量），**不衡量"写得好不好"**。
// 刻意只调端点而不自己写 SQL：汇总口径的唯一来源是 server.js 的 summarizeAIEval。
run('质量信号哨兵（客观指标快照）', process.execPath,
  ['.p1-baseline/quality-sentinel.mjs', '--base', BASE],
  { requires: () => hasBase, skipReason: '需要活实例（哨兵复用服务端汇总口径，不自己写 SQL）' });

// D8-#4：命名任务的作业接线（静态部分零成本；活体段会真的建作业，需显式授权）
run('命名任务的作业接线（静态）', process.execPath,
  ['.p1-baseline/verify-named-jobs.mjs']);
// D8-#3：记忆压缩的零损失护栏（实体变体匹配 + 覆盖率下限；含真实数据教出来的假阳性回归）
run('记忆压缩零损失护栏', process.execPath,
  ['.p1-baseline/test-memory-compress-guard.mjs']);
// D8-#3：自动压缩开关（静态部分零成本；活体段会写库并建作业，需显式授权 + 隔离实例）
run('自动压缩开关（默认关闭，"不打开不花钱"）', process.execPath,
  ['.p1-baseline/verify-auto-compress.mjs']);

run('主成文路径与创作内核同源（逐字节）', process.execPath,
  ['.p1-baseline/verify-p3-unified.mjs', BASE, DB, CHAPTER],
  { requires: () => hasBase && fs.existsSync(DB) });

// ── 5a2. 编辑距离测量点端到端（需活实例；不触发任何 harness 任务，零费用）──
run('编辑距离测量点端到端（采纳→保存→回填）', process.execPath,
  ['.p1-baseline/verify-eval-metric.mjs', BASE],
  { requires: () => hasBase });

// ── 5b. 闸门断言逻辑的离线阴性对照（零成本，默认跑）────────────────────
// 这是 2026-09-15 事故的两个直接教训的固化：
//   (1) 429 只断言状态码 → 上游 provider 限流会被误判成「闸门拦住了」；
//   (2) 「槽位已满」有寿命 → 作业结束后放行是合法的，却被判成失败。
// 两条都是纯逻辑问题，可以在完全不碰网络、不建任何任务的前提下测出来。
run('闸门断言离线阴性对照（含变异测试目标）', process.execPath,
  ['.p1-baseline/test-gate-assert.mjs']);

// ── 5b2. dsh 子进程环境契约（零成本，默认跑）──────────────────────────
// 钉住「任务必须回连发起它的那个实例」：插件侧的解析顺序会回落到安装时写死的 3737，
// 所以唯一的 spawn 出口必须给出等于本实例的默认值，否则隔离实例会把产物写进生产库。
run('harness 子进程环境契约（隔离实例不得回落 3737）', process.execPath,
  ['.p1-baseline/test-harness-env.mjs']);

// ── 5b3. P6 切换器（零成本，默认跑；不动任何真实产物）──────────────────
// 切换器最危险的失败方式是「静默无效」（锚点没命中却报成功）与「彩排改了真实文件」。
// 这两类都能在没有真实切换的前提下测出来；锚点还会与真实源码对账，源码漂移立刻红灯。
run('P6 切换器离线测试（锚点对账 + 行尾 + 幂等 + 安全网）', process.execPath,
  ['.p6-cutover/test-cutover.mjs']);

// ── 5b3b. 全量快照工具（零成本，默认跑）────────────────────────────────
// 快照工具最危险的失败模式是**排除过宽**：静默漏掉源码而仍然报绿，
// 等到真要回滚才发现少了东西。这条同时钉「该排除的排除」与「该包含的包含」。
run('全量快照工具离线测试（排除/包含/指纹/manifest 自洽）', process.execPath,
  ['.p6-cutover/test-snapshot.mjs']);

// ── 5b3c. 阶段 → 改动面 → 回滚 映射（零成本，默认跑）──────────────────
// 目标要求「每阶段独立验收与回滚」，这条保证那个映射**不会腐烂**：
// 拿真实改动集对账，出现「没归属的改动」即失败；文档由数据生成，防止手写漂移。
run('阶段映射核对（改动归属 + 证据存在 + 文档一致）', process.execPath,
  ['.p1-baseline/verify-phase-map.mjs']);

// ── 5b4. 编辑距离算得对不对（零成本，默认跑）──────────────────────────
// 这个数字会直接进「上下文质量有没有变好」的结论，算错比算不出来更糟。
run('编辑距离离线测试（精确/近似/边界/不下结论）', process.execPath,
  ['.p1-baseline/test-edit-distance.mjs']);

// ── 5b4b. 长期记忆压缩提示是否真的进到上下文（自审发现 F6）──────────────
// 层按 cap 从头部截断，而记忆无界增长；提示原先挂在末尾 → 记忆越长越会被自己截掉。
// 离线读基线 + 活实例自发现「记忆超提示线」的作品，两条都跑。
run('压缩提示在层内（离线读压力基线）', process.execPath,
  ['.p1-baseline/verify-memory-hint.mjs', '--baselines', '.p1-baseline/baselines-p5'],
  { requires: () => hasCases('.p1-baseline/baselines-p5'),
    skipReason: NO_CASES_HINT + '（该工具在空目录上会标"跳过"，这里提前跳过更清楚）' });
run('压缩提示在层内（活实例自发现）', process.execPath,
  ['.p1-baseline/verify-memory-hint.mjs', '--base', BASE],
  { requires: () => hasBase });

// ── 5b5. 模型切换互斥 = 实际吞吐（零成本，默认跑）─────────────────────
// 「允许 2 并发但实际吞吐是不是 1」此前只是论断。这条离线钉住机制：
// 闸门判断的真值表 + 互斥体真的不交错 + 失败不卡队列。
run('模型切换互斥语义（决定实际吞吐 1 还是 2）', process.execPath,
  ['.p1-baseline/test-model-switch-gate.mjs']);

// ── 5c. 并发闸门（**默认不跑**：它会真的创建 harness 任务）─────────────
// 2026-09-15 事故：作者曾以为把 DEEPSEEK_BASE_URL 指向死端口就是零成本，
// 结果多轮「零成本」验证产生了未经批准的真实 LLM 调用。因此：
//   - 必须同时给出 --gate-base **和** 显式授权环境变量，否则一律跳过；
//   - 检查自身跑前拒绝未授权运行、跑后审计是否真的花钱。
run('harness 并发闸门（会建真实任务，需显式授权）', process.execPath,
  ['.p1-baseline/verify-harness-gate.mjs', GATE_BASE],
  {
    requires: () => Boolean(GATE_BASE && process.env.NOVELSTUDIO_GATE_CONFIRMED_ISOLATED === '1'),
    skipReason: '需 --gate-base 且 NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1'
      + '（该检查会真的创建 harness 任务，未证明隔离前不跑）',
  });

// ── 5d. 隔离保证核验（离线只读）────────────────────────────────────────
// 抓的是「探针把噪声写进基线副本、被误读成真实库被动过」这类误判。
// diff-real-db.mjs 会报 app_logs 有差异；必须能证明差异方向是「副本多」而非「真实库少」。
run('真实库未被写入（app_logs 差集归因）', process.execPath,
  ['.p1-baseline/diff-log-noise.mjs', REAL_DB],
  { requires: () => fs.existsSync(REAL_DB) });

// ── 6. spawn 路径（**默认不跑**：会真的调起 dsh）─────────────────────
// 这条检查自身把 LLM 端点指向死端口（verify-harness-profile.mjs 第 20 行），
// 按已证实的机制**不产生计费**。仍然要求显式授权，是因为它会真的 spawn dsh（约 40s），
// 而"零计费"依赖该环境变量被 honored——已实测成立，但仍是外部假设。
run('dsh profile 参数在真实 spawn 路径生效（会调起 dsh）', process.execPath,
  ['.p0-recon/verify-harness-profile.mjs', 'no-such-profile-xyz'],
  {
    requires: () => process.env.NOVELSTUDIO_ALLOW_HARNESS_SPAWN === '1'
      && fs.existsSync('../deepseek-harness/package.json'),
    skipReason: '会真的 spawn dsh（脚本自设死端口，零计费；仍需显式授权）'
      + '；需 NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1',
  });

// 线路层：内核真的进了发出去的请求（15 个 novel_* 工具 + 人设）。同样要 spawn dsh。
run('线路层：专用 profile 是否把创作内核挂进请求（会调起 dsh）', process.execPath,
  ['.p0-recon/capture-dsh-request.mjs', '--profile', 'novel'],
  {
    requires: () => process.env.NOVELSTUDIO_ALLOW_HARNESS_SPAWN === '1'
      && fs.existsSync('../deepseek-harness/package.json'),
    skipReason: '会真的 spawn dsh（黑洞端点接收、自带跑后审计，零计费）；需 NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1',
  });

// ── 7. 套件总闸：本次运行有没有真的调用 LLM ────────────────────────────
// 判据来自 dsh 自己的会话转录（`request/header` + 流式产出），不靠印象。
// 有真实调用 → 判失败：要么隔离没做到，要么某条检查被授权得不该跑。
{
  const { total, real, rows } = countRealCallsSince(SUITE_T0);
  results.push({
    label: '套件总闸：本次未产生真实 LLM 调用',
    status: real > 0 ? FAIL : OK,
    evidence: real > 0
      ? `检出 ${real} 条真实调用（会话 ${total} 条）：`
        + rows.map((r) => `${r.ts} ${r.model}「${(r.userMsgs[0] || '?').slice(0, 30)}」`).join('；')
      : `未检出（窗口内 dsh 会话 ${total} 条，均无「请求 + 模型产出」）`,
    cmd: 'node .p1-baseline/audit-llm-calls.mjs --since <套件起点> --json',
  });
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const w = Math.max(...results.map((r) => r.label.length), 10);
console.log('\n══════════════ P0–P6 一键验收 ══════════════\n');
for (const r of results) {
  const mark = r.status === OK ? '✓' : r.status === SKIP ? '–' : '✗';
  console.log(`${mark} ${r.label.padEnd(w)}  ${r.status}`);
  if (r.evidence) console.log(`  ${' '.repeat(w)}  └ ${r.evidence}`);
}
const pass = results.filter((r) => r.status === OK).length;
const fail = results.filter((r) => r.status === FAIL).length;
const skip = results.filter((r) => r.status === SKIP).length;
console.log(`\n合计：通过 ${pass} / 未通过 ${fail} / 跳过 ${skip}`);
if (skip) console.log(`跳过的原因通常是缺活实例或外部仓库；它们不是通过，请勿当成通过。`);
console.log('若「套件总闸」判为未通过：说明本次真的调用了 LLM（花钱了）。'
  + '先查 audit-llm-calls 的明细，再决定是隔离没做到、还是某条检查不该跑。');
if (!hasBase) console.log(`\n提示：未探测到实例 ${BASE}。启动方式见 docs/p6-cutover-runbook.md §八（隔离环境）。`);
console.log('\n复现命令已在上面逐条给出；也可单独运行对应工具。');
process.exitCode = fail ? 1 : 0;
