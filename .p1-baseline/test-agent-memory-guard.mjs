#!/usr/bin/env node
/**
 * test-agent-memory-guard.mjs —— 「**模型自压缩**也走零损失护栏」的离线单测（零成本）。
 *
 * ── 背景 ──────────────────────────────────────────────────────────────────────
 * D8-#3 的护栏此前只保护**服务端自动压缩**（`compressStoryMemory`）。而插件人设教的
 * 恰恰是「模型自行把旧摘要+进展压缩成 ≤800 字，再调 `novel_memory_update` 交上来」——
 * 那条路此前**没有护栏**：模型丢掉一个角色照样静默落库，而这段记忆会喂给之后每一章，
 * 且摘要读起来照样通顺（这正是最难发现的一类损失）。
 *
 * ── 本测试考什么 ──────────────────────────────────────────────────────────────
 *   1) 出场侧：出场过的（含别名变体）一个都不许丢；
 *   2) 未出场侧：默认放行、严格模式才拒绝——且**策略在用例里显式钉住**，不依赖环境变量
 *      （「测试跟着环境变量漂移」这个坑在 D8 里犯过两次）；
 *   3) **阴性对照（变异体）**：把 mustKeep 换回修复前的"整张角色表"，同一份**没丢人**的
 *      好摘要必须被它误判成"丢人"——证明"按出场分两侧"是必要的，不是装饰；
 *   4) `needsAgentMemoryGuard` 的**真值表**：作者手改、delta 追加、提案路径都不得设闸；
 *   5) 跨模块契约：插件**不能** import 本内核模块（它会被复制到 agent-presets，旁边没有
 *      `ai/`），所以两边靠字面量对齐——必须断言两侧一致，否则静默失配。
 *
 * 用法: node .p1-baseline/test-agent-memory-guard.mjs
 */
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  agentMemoryUpdateVerdict,
  needsAgentMemoryGuard,
  AGENT_GUARD_MARKER,
  checkCompression,
  mustKeepEntities,
} from '../ai/memory-compress-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'harness-plugins', 'novel-writing');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ── 夹具：刻意复刻真实数据的形状（带括号别名、含一条"括号里是一整句描述"的词条）──
const CHARACTERS = [
  { name: '沈砚' },
  { name: '林晚（社里人称“晚姐”）' },
  { name: '陆知白' },
  { name: '秦五' },
  { name: '旧日支配者（海澜市地底沉睡的那一位；仪式者只敢称“祂”）' },
];
const WORLDS = [{ title: '潮雾规则' }, { title: '未启用的设定' }];
const CHAPTER_TEXT = '沈砚在拾线坊替人补记忆。林晚带来一桩失踪案，按潮雾规则行事。陆知白一直沉默。';
// ⚠️ 夹具里的实体**只出现一次**（D8 的教训：用 padEnd 重复填充会让"删掉它"的用例假失败）。
const GOOD = '沈砚在拾线坊替人补记忆，林晚追查失踪案，陆知白保持沉默；一切按潮雾规则行事。'
  + '被缝回去的记忆并不总是原来的样子，他补过三次，三次都留下了缺口。'.repeat(3);

const V = (summary, extra = {}) => agentMemoryUpdateVerdict({
  characters: CHARACTERS, worldEntries: WORLDS, chapterText: CHAPTER_TEXT, summary, ...extra,
});

console.log('【1. 出场侧：出场过的一个都不许丢】');
{
  const good = V(GOOD);
  ok('实体齐全 → 通过', good.ok === true, JSON.stringify(good.reasons));
  ok('两侧划分正确（出场 3 / 未出场 2）',
    good.cast.appearedChars.length === 3 && good.cast.absentChars.length === 2,
    `appeared=${good.cast.appearedChars.length} absent=${good.cast.absentChars.length}`);
  ok('世界观同样分两侧（出场 1 / 未出场 1）',
    good.cast.appearedWorlds.length === 1 && good.cast.absentWorlds.length === 1);

  const dropChar = V(GOOD.replace('林晚', '那位记者'));
  ok('丢掉出场角色 → 拒绝，且名单里指名道姓',
    dropChar.ok === false && dropChar.guard.missing.includes('林晚（社里人称“晚姐”）'),
    JSON.stringify(dropChar.guard.missing));

  const dropWorld = V(GOOD.replace(/潮雾规则/g, '某种规则'));
  ok('丢掉出场世界观词条 → 拒绝',
    dropWorld.ok === false && dropWorld.guard.missing.includes('潮雾规则'),
    JSON.stringify(dropWorld.guard.missing));
}

console.log('\n【2. 别名变体：模型写简称也算保留（真实假阳性回归）】');
{
  // 2026-09-16 的真实调用教出来的：库里的名字带括号别名，模型写的是简称。
  // 逐字比对完整串 = 要求模型照抄我们的写法，那是假阳性，不是零损失。
  const alias = V(GOOD.replace('林晚', '晚姐'));
  ok('只写别名「晚姐」→ 仍算保留（不误判为丢人）', alias.ok === true, JSON.stringify(alias.reasons));
}

console.log('\n【3. 未出场侧：默认放行 / 严格拒绝（策略显式钉住，不读环境变量）】');
{
  const withInvented = GOOD + '秦五也在场。';
  const relaxed = V(withInvented, { strictInvention: false });
  ok('默认策略：提到未出场角色 → 仍放行（用户规格「根据剧情需要出现」）',
    relaxed.ok === true && relaxed.inventionAction === 'allow', JSON.stringify(relaxed.reasons));
  ok('放行时如实报出是谁（留痕，不静默）',
    relaxed.invention.invented.includes('秦五'), JSON.stringify(relaxed.invention.invented));

  const strictMode = V(withInvented, { strictInvention: true });
  ok('严格模式：同一份内容 → 拒绝', strictMode.ok === false && strictMode.inventionAction === 'reject');
}

console.log('\n【4. 空 / 过短：必须拒绝，而不是当成"没丢实体"放行】');
{
  const empty = V('   ');
  ok('空摘要 → 拒绝', empty.ok === false && /为空/.test(empty.reasons.join('；')));
  const short = V('沈砚 林晚 陆知白 潮雾规则');
  ok('实体齐全但过短 → 拒绝（装不下角色状态与伏笔）',
    short.ok === false && /过短/.test(short.reasons.join('；')), JSON.stringify(short.reasons));
}

console.log('\n【5. 阴性对照（变异体）：修复前的"整张角色表"做法会误判这份好摘要】');
{
  // 这就是护栏第一版的判据：拿 characters 全表当 mustKeep。
  // 若它也判 GOOD 通过，说明"按出场分两侧"没有实际作用，本测试就是空转。
  const legacy = checkCompression({
    compressed: GOOD,
    mustKeep: mustKeepEntities({ characters: CHARACTERS, worldEntries: WORLDS }),
    minCoverage: 1,
  });
  ok('变异体确实把 GOOD 判成"丢人"（证明分两侧不是装饰）',
    legacy.ok === false && legacy.missing.includes('秦五'),
    `legacy.missing=${JSON.stringify(legacy.missing)}`);
  ok('同一份 GOOD，新判据通过而变异体拒绝 —— 两者结论相反',
    V(GOOD).ok === true && legacy.ok === false);
}

console.log('\n【6. needsAgentMemoryGuard 真值表：该设闸的设闸，不该设闸的一个都不设】');
{
  ok('工具标记 + summary → 设闸', needsAgentMemoryGuard({ guard: 'agent', summary: '正文' }) === true);
  ok('工具标记 + 只传 delta → 不设闸（delta 是纯拼接，丢不了东西）',
    needsAgentMemoryGuard({ guard: 'agent', delta: '增量' }) === false);
  ok('工具标记 + summary 全空白 → 不设闸',
    needsAgentMemoryGuard({ guard: 'agent', summary: '   ' }) === false);
  ok('提案路径 → 不设闸（先落提案表，等作者确认时才走正式写入）',
    needsAgentMemoryGuard({ guard: 'agent', summary: '正文', proposed: true }) === false);
  ok('★ 作者手改（无标记）→ 不设闸（机器判据不该挡住作者的手）',
    needsAgentMemoryGuard({ summary: '作者自己写的摘要' }) === false);
  ok('标记值不符 → 不设闸', needsAgentMemoryGuard({ guard: 'other', summary: '正文' }) === false);
  ok('空 / null 入参 → 不设闸且不抛',
    needsAgentMemoryGuard({}) === false && needsAgentMemoryGuard(null) === false);
}

console.log('\n【7. 跨模块契约：两侧靠字面量对齐，失配必须被抓住】');
{
  const TOOLS = readFileSync(path.join(PLUGIN, 'novel-tools.mjs'), 'utf8');
  const PATCH = readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8');
  const AGENT = readFileSync(path.join(PLUGIN, 'agent.cordis.yml'), 'utf8');
  const SERVER = readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  ok('内核标记值就是工具侧写的那个字符串', AGENT_GUARD_MARKER === 'agent', AGENT_GUARD_MARKER);
  ok('novel-tools.mjs 确实发送该标记（容忍引号/空格差异）',
    /guard\s*:\s*['"]agent['"]/.test(TOOLS));
  ok('novel-tools.mjs 的 novel_memory_update 描述含零损失纪律',
    /零损失/.test(TOOLS));
  ok('server.js 用纯判据决定是否设闸（而不是散在 handler 里比字符串）',
    /needsAgentMemoryGuard\s*\(/.test(SERVER));
  ok('server.js 调用了整份判据', /agentMemoryUpdateVerdict\s*\(/.test(SERVER));
  ok('人设两侧都写了零损失纪律（两文件必须同步）',
    /零损失/.test(PATCH) && /零损失/.test(AGENT));
  ok('人设两侧都说明了召回缺口占位层的含义',
    /相关记忆检索/.test(PATCH) && /相关记忆检索/.test(AGENT));

  // 阴性对照：上面的存在性断言本身必须有能力失败，否则它只是恒真。
  const missing = (text, needle) => new RegExp(needle).test(text);
  ok('阴性对照：同一判据对"挖掉标记的文本"报缺失',
    missing('body = { summary: x }', "guard\\s*:\\s*['\"]agent['\"]") === false
    && missing("guard: 'agent'", "guard\\s*:\\s*['\"]agent['\"]") === true);
}

console.log('\n【8. 安装器的目标 home：必须与运行时同语义（决策 B 之后不是 ~/.dsh）】');
{
  const { DEDICATED_HOME_ENV: ENV_A, DEFAULT_DEDICATED_HOME: DEF_A } = await import('../ai/harness-env.mjs');
  const PROFILE_SRC = readFileSync(path.join(PLUGIN, 'install-profile.mjs'), 'utf8');
  ok('专用 home 的环境变量名两侧字面量一致',
    ENV_A === 'NOVELSTUDIO_DSH_HOME' && PROFILE_SRC.includes(`'${ENV_A}'`), ENV_A);
  ok('专用 home 的目录名两侧字面量一致',
    DEF_A === '.dsh-novel' && PROFILE_SRC.includes(`'${DEF_A}'`), DEF_A);

  // ⚠️ 下面这一行 import 本身就是一条断言：install-profile.mjs 曾无条件 `main()`，
  // 导入即接线。加了入口守卫之后，import 一个**纯函数**才是安全的。
  const { resolveTargetHome } = await import(pathToFileURL(path.join(PLUGIN, 'install-profile.mjs')).href);
  ok('导入安装器不会执行安装（入口守卫生效）', typeof resolveTargetHome === 'function');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-'));
  const sharedDir = path.join(tmp, '.dsh');
  const dedDir = path.join(tmp, '.dsh-novel');
  fs.mkdirSync(path.join(sharedDir, 'profiles'), { recursive: true });
  ok('专用 home 不存在 → 退回共享 home',
    resolveTargetHome('', {}, tmp).home === sharedDir, resolveTargetHome('', {}, tmp).home);
  fs.mkdirSync(path.join(dedDir, 'profiles'), { recursive: true });
  ok('★ 专用 home 存在 → 选它（而不是共享 home）——这正是此前装错位置的缺陷',
    resolveTargetHome('', {}, tmp).home === dedDir, resolveTargetHome('', {}, tmp).home);
  ok('--home 优先于一切', resolveTargetHome(sharedDir, {}, tmp).home === sharedDir);
  ok('环境变量优先于自动探测',
    resolveTargetHome('', { [ENV_A]: sharedDir }, tmp).home === sharedDir);
  fs.rmSync(tmp, { recursive: true, force: true });
  ok('临时目录已清理', !fs.existsSync(tmp));

  // 阴性对照：home 下**只有**专用目录时，绝不能挑中一个不存在的共享 home。
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nh2-'));
  fs.mkdirSync(path.join(tmp2, '.dsh-novel', 'profiles'), { recursive: true });
  const picked = resolveTargetHome('', {}, tmp2);
  ok('阴性对照：只有专用 home 时选专用 home（不回落成 ~/.dsh）',
    picked.home === path.join(tmp2, '.dsh-novel') && !/\.dsh$/.test(picked.home), picked.home);
  fs.rmSync(tmp2, { recursive: true, force: true });
}

console.log(`\n${fails.length === 0 ? '✓' : '✗'} 共 ${pass + fails.length} 条断言，通过 ${pass}，失败 ${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
  process.exitCode = 1;
}
