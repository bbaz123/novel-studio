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
 *   node .p1-baseline/verify-all.mjs --real-db <对比副本> --live-db <真实库>   # 两个库各有用处，别混（见 LIVE_DB）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { auditSessions, attributeSyntheticSessions } from './audit-llm-calls.mjs';

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
// ⚠️ REAL_DB 名字叫「真实」，实际是 diff-log-noise 用来对比的**副本**（可能早于真实库：
// 实测副本里只有示例作品 2/9，比真实库少 113 行日志）。「连续性预检在真实作品上成立」
// 那条要的是**真的写过章节的那个库**，所以它单独一个入口——传错库会把"测不了"伪装成一条失败。
const LIVE_DB = arg('--live-db', 'data/novel.db');
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

/**
 * 跑一条命令，只取退出码；输出里挑一行结论作为证据。
 *
 * 退出码约定：0 = 通过；**2 = 跑不了**（工具自己声明"没有可测对象"——比较器空目录、
 * 连续性预检在没有已写正文的章节上都属于这一类）→ 标成跳过，而不是未通过。
 * 这两件事必须分开：前者是环境缺料，后者是回归——混在一起红灯就失去意义了。
 * （此前只有 `requires` 这一个前置口径，于是"工具自报跑不了"仍被记成未通过。）
 */
/**
 * 零计费探针的**自证行**：用本地假端点充当模型的检查会打一行
 * `SYNTHETIC_MODEL_SESSION {...}`（契约见 audit-llm-calls.mjs 的 attributeSyntheticSessions）。
 * 总闸据此把「拿到模型文本」的会话逐条归属；**归属不了仍然判红**——
 * 这行只是自证材料，不是豁免券。
 */
const SYNTHETIC_DECL_RE = /^SYNTHETIC_MODEL_SESSION (\{.*\})$/gm;
const syntheticDeclarations = [];
function collectSyntheticDeclarations(out) {
  for (const m of String(out).matchAll(SYNTHETIC_DECL_RE)) {
    try {
      const d = JSON.parse(m[1]);
      if (d && typeof d.endpoint === 'string') syntheticDeclarations.push(d);
    } catch { /* 申报行坏掉 = 没有自证：那条会话随后会因无法归属判红 */ }
  }
}

function run(label, cmd, args, { cwd = process.cwd(), requires, skipReason } = {}) {
  if (requires && !requires()) {
    results.push({ label, status: SKIP, evidence: skipReason || '前置不满足', cmd: `${cmd} ${args.join(' ')}` });
    return;
  }
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  collectSyntheticDeclarations(out);   // 自证行（见本文件 collectSyntheticDeclarations）
  const status = r.status === 0 ? OK : (r.status === 2 ? SKIP : FAIL);
  results.push({
    label,
    status,
    evidence: status === SKIP && r.status === 2
      ? `工具自报「跑不了」（退出码 2）：${pickEvidence(out) || '未给出原因'}`
      : pickEvidence(out),
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
 * 活实例里那几条检查要拿"某个真实章节"当探针，而 --work/--chapter 的默认值是**压力测试库**
 * 的口径（16/227）。换库（--base 指向真实作品）却不换这两个参数时，探针会指向一个不存在的
 * 章节 → 工具抛错 → 被记成"未通过"，把"参数没配对"伪装成"能力退化"。
 * 所以先确认探针在**本库**里真的存在；不存在就按"跑不了"跳过（与 hasCases 同一原则）。
 */
function probeTargetReady() {
  if (!fs.existsSync(DB)) return false;
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE id = ?').get(Number(CHAPTER));
    db.close();
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}
const PROBE_HINT = `探针章节 #${CHAPTER} 不在 ${DB}（--work/--chapter 默认值是压力测试库口径）；`
  + '换成别的库请一并传 --db/--work/--chapter';

/**
 * 探针要**两边都认**：库里查得到（上面那条），活实例也认得（实例可能服务的是另一个库）。
 * 只有一边认账就说明探针指错了库——那仍然属于"跑不了"，不该记成能力退化。
 */
const probeInDb = probeTargetReady();
const probeInLive = hasBase
  ? (await fetch(`${BASE}/api/ai_context?chapter_id=${CHAPTER}`)).ok
  : false;
const probeReady = probeInDb && probeInLive;
const PROBE_SKIP = probeInDb
  ? `活实例 ${BASE} 里没有章节 #${CHAPTER}（实例服务的是别的库）；请传与该实例一致的 --db/--work/--chapter`
  : PROBE_HINT;

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
// 第三步：Host Contract 冻结后，契约漂移必须能被一键验收抓到（离线、零计费）：
//   代码↔契约（层/预算/清单字段/策略/工具面/端点面/日志层级/表清单）、文档↔契约、边界是否真的成立、旧库兼容。
run('Host Contract 契约测试（含负向对照）', process.execPath, ['.p1-baseline/test-host-contract.mjs']);
// 第四步：确定性故事状态内核的**活实例端到端**测试（零计费：自建作品、自清理，不调模型）。
// 三条只能对着真库/真 HTTP 才能证明的事：开关关掉时真的什么都不发生、提案真的会陈旧、回滚真的不删行。
// 2026-09-26 增补（第五步 Golden Novel 联合回归抓到的两个真实缺陷的回归）：S14 角色知识提案端到端
// （ON CONFLICT 谓词缺失曾让整条路不可用）、S15 知识可见窗口三态方向（unknown 只在学到之前显示）。
run('故事状态端到端（开关/提案/陈旧/回滚/预检/校验）', process.execPath,
  ['.p1-baseline/test-story-state-api.mjs', '--base', BASE],
  { requires: () => hasBase, skipReason: '需要活实例（该测试自建作品并自清理，零计费）' });
// T1–T8 时态故事状态重构：新增零依赖总入口（领域/存储/历史查询；清单为空或子测试失败时非零退出）。
run('时态故事状态重构（reducer/历史/完整性，零计费）', process.execPath,
  ['scripts/test-temporal-refactor.mjs'],
  { requires: () => fs.existsSync('scripts/test-temporal-refactor.mjs'), skipReason: '测试入口不存在' });
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
// 常驻 dsh 热备池：协议层（NDJSON/JSON-RPC、会话隔离、终态、超时/取消/进程死亡）+ 池策略
// （热备命中、后台补位、LRU、空闲回收、关闭竞态）。注入进程内假 dsh，**不需要 dsh、零成本**。
// 变异锚点用同目录的 mutation-check-harness-pool.mjs 单独跑（它会改文件再还原，不进默认套件）。
run('常驻热备池（协议 + 池策略，注入假 dsh）', process.execPath,
  ['.p1-baseline/test-harness-pool.mjs']);
// dsh 启动路径选择：**优先预构建产物**（省掉每任务现场 tsx 转译，实测冷启动 12.6s → 1.9s），
// 但必须有防陈旧判据（源码比产物新就回退源码）。这里钉的是那两条纯函数的真值表。
run('dsh 启动路径（预构建优先 + 防陈旧）', process.execPath,
  ['.p1-baseline/test-dsh-launch.mjs']);

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
  { requires: () => probeReady, skipReason: PROBE_SKIP });

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
// 2026-09-24：记忆压缩**提示词输入**的离线单测（含阴性对照）。
// 它钉的是一个静默缺陷：提示词里"最近章节尾部"那段曾经恒为空（引用了已被删除的查询别名）。
run('记忆压缩提示词输入（含阴性对照）', process.execPath,
  ['.p1-baseline/test-memory-compress-prompt.mjs']);
// 2026-09-24：上下文清单 / 完整性 / 溯源（主体 V2 的 P0）。
// 关键在阴性对照：把清单或文字故意改坏，完整性判据必须判 FAIL —— 否则那套检查只是装饰。
run('上下文清单/完整性/溯源（含阴性对照）', process.execPath,
  ['.p1-baseline/test-context-manifest.mjs']);
// 2026-09-24：记忆压缩输入的前后对照（真实作品数据、只读、零计费）。
run('记忆压缩输入前后对照（真实数据）', process.execPath,
  ['.p1-baseline/verify-memory-compress-input.mjs', '--db', DB, '--all'],
  { requires: () => fs.existsSync(DB), skipReason: `找不到数据库 ${DB}` });
// D8-#3：自动压缩开关（静态部分零成本；活体段会写库并建作业，需显式授权 + 隔离实例）
run('自动压缩开关（默认关闭，"不打开不花钱"）', process.execPath,
  ['.p1-baseline/verify-auto-compress.mjs']);

run('主成文路径与创作内核同源（逐字节）', process.execPath,
  ['.p1-baseline/verify-p3-unified.mjs', BASE, DB, CHAPTER],
  { requires: () => probeReady, skipReason: PROBE_SKIP });

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

// ── 5b3d. 确定性连续性预检（零成本，默认跑）─────────────────────────────
// 2026-09-22 报告第 1 步：审稿前先把**机器能判定**的四件事算掉（角色卡时点 / 系统出场频率 /
// 篇幅口径 / 剧情线推进）。两条都零网络、零计费：
//   · 离线那条跑真值表与**阴性对照**——它防的是最危险的一类缺陷：「写了判据但从没被用上」
//     与「缺判据时猜一个」（猜出来的假阳性会让作者关掉整个预检）；
//   · 真实库那条是**通过线**的测量：在作品 18 上必须命中第 5/6 章审稿报告里可确定复现的那几条，
//     同时**不许**报已经改好的旧草稿问题（第 6 章篇幅）——拿旧结论报新定稿的预检是坏的预检。
// ⚠️ 真实库那条只读打开（`readOnly: true`），不会写任何作品数据。
run('确定性连续性预检（真值表 + 阴性对照 + 接线）', process.execPath,
  ['.p1-baseline/test-continuity-guard.mjs']);
run('连续性预检在真实作品上成立（命中/误报/豁免闭环）', process.execPath,
  ['.p1-baseline/verify-continuity-guard-on-real-data.mjs', '--db', LIVE_DB],
  { requires: () => fs.existsSync(LIVE_DB),
    skipReason: `需要真实库 ${LIVE_DB}（可用 --live-db 指定；该脚本只读打开，不写任何作品数据）` });

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
// 判据（2026-09-22 校正）：把「真实库有、副本没有」拆成**副本采样之后的正常增长**（不判红）
// 与「副本 id 范围内缺失 / 带探针特征的新增」（判红）。旧版一律判红——副本是某次采样，
// 真实库是活的，于是正常使用下恒为假警（实测 113 行正常日志被误报成「真实库被删过」）。
// 自检那条把两个方向都钉住：正常增长必须绿、探针写入与分叉必须红。
const REAL_DB_NOTE = '（REAL_DB 是**副本**：默认 .p1-baseline/data/novel.db，可用 --real-db 指定）';
run('真实库未被删改（app_logs 差集归因；正常增长不判红）', process.execPath,
  ['.p1-baseline/diff-log-noise.mjs', REAL_DB],
  { requires: () => fs.existsSync(REAL_DB), skipReason: `需要副本库 ${REAL_DB}${REAL_DB_NOTE}` });
run('日志差集归因判据自检（正常增长不判红 / 探针写入与分叉判红）', process.execPath,
  ['.p1-baseline/diff-log-noise.mjs', '--self-test']);

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

// 工具循环：慢通道与直连的**真正差别**（模型 → 工具 → 模型）。同样要 spawn dsh。
// 为什么值得占一条：这条链路此前只能靠读代码推断（假端点只会回正文），
// 而它是"读回被裁层 / 写回提案"这类创作能力的必经之路。
run('工具循环：模型 → 工具 → 模型 真的跑通（会调起 dsh）', process.execPath,
  ['.p1-baseline/probe-harness-tool-loop.mjs'],
  {
    requires: () => process.env.NOVELSTUDIO_ALLOW_HARNESS_SPAWN === '1'
      && fs.existsSync('../deepseek-harness/package.json'),
    skipReason: '会真的 spawn dsh（自设假端点、零计费）；需 NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1',
  });

// ── 7. 套件总闸：本次运行有没有真的调用 LLM ────────────────────────────
// 判据来自 dsh 自己的会话转录（`request/header` + 流式产出），不靠印象。
// 有真实调用 → 判失败：要么隔离没做到，要么某条检查被授权得不该跑。
//
// 2026-09-25 加第二层：凡「拿到模型文本」的会话都要**逐条归属**。零计费探针
// （工具循环 / 冷启动）用本地假端点充当模型，形态与真调用相同，必须由端点自己打
// 自证行（SYNTHETIC_MODEL_SESSION）；四重核对见 audit-llm-calls.mjs 的
// attributeSyntheticSessions()。**归属不了的文本会话仍然是红灯**——这一层只严不松。
{
  const { rows } = auditSessions({ sinceMs: SUITE_T0 });
  const { attributed, unexplained } = attributeSyntheticSessions(rows, syntheticDeclarations);
  const hosts = [...new Set(attributed.map((a) => {
    try { return new URL(a.decl.endpoint).host; } catch { return String(a.decl.endpoint); }
  }))];
  results.push({
    label: '套件总闸：本次未产生真实 LLM 调用',
    status: unexplained.length ? FAIL : OK,
    evidence: unexplained.length
      ? `检出 ${unexplained.length} 条**无法归属**的模型文本（会话 ${rows.length} 条）：`
        + unexplained.map((r) => `${r.ts} ${r.model || '?'}「${(r.userMsgs[0] || '?').slice(0, 30)}」`).join('；')
        + '；要么真花了钱，要么某条零计费探针漏打自证行（SYNTHETIC_MODEL_SESSION）'
      : (attributed.length
        ? `未检出（窗口内 dsh 会话 ${rows.length} 条：其中 ${attributed.length} 条拿到模型文本，`
          + `全部由本地假端点自证归属 ${hosts.join(', ')}——回环端点 + 实收数≥转录数 + 正文等于罐头文本）`
        : `未检出（窗口内 dsh 会话 ${rows.length} 条，均无「请求 + 模型产出」）`),
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
