#!/usr/bin/env node
/**
 * test-editing-rules.mjs —— R07「三档编辑 + 编辑保护规则 + 能力目录 + 题材档」隔离测试（零计费）。
 *
 * 覆盖（任务书 §10.3 的验收判据，逐条落到断言）：
 *   A. 纯模块：目录/版本/hash 稳定；白名单解析（未知 tier/能力/题材如实回报且不采用）；
 *      保护规则在所有档位都在；能力按任务与题材决定是否加载；同一选择 → 同一 hash（确定性）。
 *   B. 请求可见性：打开开关后规则块真的进入 `/api/novel/context` 的 assembled（=目标请求的提示词正文），
 *      关闭后**不进入**（且 assembled 与基线逐字节一致）；R05 贡献记录里有 layer:edit_rules 与内容 hash。
 *   C. 能力逐项 fixture：**目录里每一项**能力各自「启用→进入请求 / 关闭→不进入」；
 *      「题材不适用 → 不加载」有明确 decision 原因（genre_not_applicable）。
 *      ⚠ 这里**不写死能力条数**：条数与名字从 editingRuleCatalog() 派生，`abilityTexts` 必须覆盖目录全部 id
 *      （C 段自己断言这一点）——2026-10-02 新增三项能力时，硬编码的 7 让三条 C 断言假红且一条漏检。
 *   D. 写入边界：模型侧（X-Novel-Agent）不能改编辑规则开关（403）。
 *   E. 确定性扫描：结构化 finding（规则/位置/摘录/严重性/建议），关闭能力不产生对应 finding。
 *
 * 用法: node .p1-baseline/test-editing-rules.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTECTION_RULES, EDIT_TIERS, ABILITIES, GENRES, EDITING_RULE_VERSION,
  editingRuleCatalog, resolveEditingSelection, editingSelectionToSettings,
  abilityDecision, buildEditingRuleBlock, ruleHash,
} from '../ai/editing/rules.mjs';
import { scanEditing } from '../ai/editing/scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(6200 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(6200 + (process.pid % 300)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-editrules-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ══════════════════ A. 纯模块 ══════════════════
console.log('【A. 规则资产（纯模块）】');
{
  const catalog = editingRuleCatalog();
  ok('A1 目录：三档 + 七题材 + 保护规则，且都带版本/hash（能力条数不写死，见 A2）',
    catalog.tiers.length === 3 && catalog.genres.length === 7
      && catalog.abilities.length === ABILITIES.length && catalog.abilities.length > 0
      && catalog.version === EDITING_RULE_VERSION
      && [...catalog.tiers, ...catalog.abilities, ...catalog.genres, catalog.protection].every((r) => /^[0-9a-f]{16}$/.test(r.hash) && r.version === EDITING_RULE_VERSION),
    JSON.stringify({ tiers: catalog.tiers.length, abilities: catalog.abilities.length, genres: catalog.genres.length }));
  ok('A2 能力目录覆盖任务书点名的那批（id 命名自由，能力覆盖不可少）',
    ['fiction-humanizer', 'dialogue-editor', 'webnovel-pacing', 'mystery-review', 'romance-review', 'character-voice', 'chapter-hook']
      .every((id) => catalog.abilities.some((a) => a.id === id))
      && ['narrative-distance', 'scene-logic', 'style-density']
        .every((id) => catalog.abilities.some((a) => a.id === id)));
  ok('A3 新增能力默认关闭（不改变旧作品既有生成行为）',
    catalog.abilities.every((a) => a.default_enabled === false));
  ok('A4 白名单解析：未知值如实回报且不采用',
    (() => {
      const s = resolveEditingSelection({ edit_rules_enabled: '1', edit_tier: 'turbo', edit_genre: 'xianxia', edit_abilities: 'fiction-humanizer,not-a-real-ability' });
      return s.tier === 'light' && s.genre === 'general' && s.abilities.join(',') === 'fiction-humanizer'
        && s.invalid.includes('tier:turbo') && s.invalid.includes('genre:xianxia') && s.invalid.includes('ability:not-a-real-ability');
    })());
  ok('A5 序列化可回读（保存 → 解析，结果一致）',
    (() => {
      const stored = editingSelectionToSettings({ enabled: true, tier: 'deai', abilities: ['chapter-hook', 'chapter-hook', 'mystery-review'], genre: 'mystery' });
      const back = resolveEditingSelection(stored);
      return stored.edit_abilities === 'chapter-hook,mystery-review' && back.enabled && back.tier === 'deai' && back.genre === 'mystery' && back.abilities.length === 2;
    })());
  ok('A6 保护规则在每一档都存在，且逐档指令不同',
    (() => {
      const blocks = EDIT_TIERS.map((t) => buildEditingRuleBlock({ enabled: true, tier: t.id, abilities: [], genre: 'general' }, {}));
      return blocks.every((b) => b.text.includes(PROTECTION_RULES.slice(0, 30)))
        && new Set(blocks.map((b) => b.hash)).size === 3;
    })());
  ok('A7 确定性：同一选择 → 同一规则块 hash（可追踪、可复验）',
    (() => {
      const sel = { enabled: true, tier: 'deep', abilities: ['dialogue-editor'], genre: 'urban' };
      const a = buildEditingRuleBlock(sel, { task: 'write' });
      const b = buildEditingRuleBlock({ ...sel, abilities: ['dialogue-editor'] }, { task: 'write' });
      return a.hash === b.hash && a.text === b.text && /^[0-9a-f]{16}$/.test(a.hash);
    })());
  ok('A8 能力按任务门控（review 能力不写进 write 任务的规则块）',
    (() => {
      const writeBlock = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: ['mystery-review'], genre: 'mystery' }, { task: 'write' });
      const reviewBlock = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: ['mystery-review'], genre: 'mystery' }, { task: 'review' });
      const anyAbility = (b) => b.sources.some((s) => s.kind === 'ability');
      return !anyAbility(writeBlock) && anyAbility(reviewBlock)
        && writeBlock.decisions.some((d) => d.id === 'mystery-review' && !d.load && d.reason.startsWith('task_not_applicable'));
    })());
  ok('A9 题材不适用 → 不加载，并给出可核对的原因',
    (() => {
      // webnovel-pacing 的题材亲和里没有「历史」→ 历史档下应被跳过
      const dec = abilityDecision(ABILITIES.find((a) => a.id === 'webnovel-pacing'), { task: 'write', genre: 'history' });
      const block = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: ['webnovel-pacing'], genre: 'history' }, { task: 'write' });
      return dec.load === false && dec.reason === 'genre_not_applicable(history)'
        && !block.text.includes('能力·网文节奏')
        && block.decisions.some((d) => d.id === 'webnovel-pacing' && !d.load);
    })());
  ok('A10 题材档只在选中时进入规则块（通用 = 不加载题材侧重）',
    (() => {
      const general = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: [], genre: 'general' }, {});
      const mystery = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: [], genre: 'mystery' }, {});
      return !/题材侧重/.test(general.text) && /题材侧重·悬疑/.test(mystery.text)
        && general.hash !== mystery.hash;
    })());
  ok('A11 规则文本是本项目自写（不出现上游项目名当作规则来源）',
    !/SillyTavern|Humanizer|InkOS|webnovel-writer|Oh Story/.test(PROTECTION_RULES + ABILITIES.map((a) => a.rule).join('') + GENRES.map((g) => g.focus).join('')));
  ok('A12 ruleHash 口径与宿主其它 hash 一致（sha16）', ruleHash('abc') === ruleHash('abc') && ruleHash('abc') !== ruleHash('abd'));
}

// ══════════════════ E. 确定性扫描（纯模块）══════════════════
console.log('【E. 确定性扫描（纯模块）】');
{
  const text = [
    '「你终于来了。」林昭淡淡地说。',
    '「我在等一个解释。」他淡淡地说。',
    '空气仿佛凝固了，时间似乎静止，他不由得嘴角勾起一抹冷笑。',
    '这一切都值得。',
    '他意识到自己爱上了她。',
    '重复的段落内容在这里出现。',
    '重复的段落内容在这里出现。',
  ].join('\n');
  const on = scanEditing(text, { abilities: ABILITIES.map((a) => a.id), genre: 'general', task: 'review', characters: [{ name: '林昭' }], foreshadows: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }, { id: 3, status: 'open' }] });
  const ids = (r) => r.findings.map((f) => f.rule_id);
  ok('E1 finding 结构齐全（规则/严重性/段号/摘录/建议/层=deterministic）',
    on.findings.length > 0 && on.findings.every((f) => f.rule_id.startsWith('deterministic:') && ['high', 'medium', 'low'].includes(f.severity)
      && typeof f.message === 'string' && typeof f.suggestion === 'string' && f.layer === 'deterministic'));
  ok('E2 机械表达被识别（仿佛/似乎/不由得/万能笑/空泛升华）', ids(on).filter((x) => x === 'deterministic:ai-tell').length >= 3, JSON.stringify(ids(on)));
  ok('E3 逐字重复段被判 high（误粘贴必须响亮）', on.findings.some((f) => f.rule_id === 'deterministic:duplicate-paragraph' && f.severity === 'high'));
  ok('E4 感情线用旁白宣布情感 → 命中 romance-tell', ids(on).includes('deterministic:romance-tell'));
  ok('E5 章尾没有钩子 → 命中 chapter-hook', ids(on).includes('deterministic:chapter-hook'));
  ok('E6 扫描口径如实声明（确定性层，不等于模型审稿）', on.scanned.deterministic === true && typeof on.scanned.paragraphs === 'number');
  const off = scanEditing(text, { abilities: [], genre: 'general', task: 'review' });
  ok('E7 关闭的能力不产生对应 finding（开关有真实输出差）',
    !ids(off).includes('deterministic:ai-tell') && !ids(off).includes('deterministic:romance-tell')
      && off.skipped.every((s) => s.reason === 'disabled') && off.skipped.length === ABILITIES.length);
  ok('E8 与档位无关的重复检测在关闭能力时仍然工作', ids(off).includes('deterministic:duplicate-paragraph'));

  // ── E9–E14：2026-10-02 第三轮（作者逐句意见）新增的两类「叙述者在场」与场景逻辑判据 ──
  // 这一组的价值在于钉住"旧规则测不到的那部分"：它们不是用词问题，词表型红线永远不响。
  const chanceText = [
    '他原本以为今天早上能讨一个说法。',
    '他在心里把这句话转了很多遍，转顺了，顺到张嘴就能说出来。',
    '他想发火。这个年纪遇到这种事，砸个东西也行，骂两句也行。',
  ].join('\n');
  const narr = scanEditing(chanceText, { abilities: ['narrative-distance'], genre: 'general', task: 'review' });
  const narrIds = (r) => r.findings.map((f) => f.rule_id);
  ok('E9 过程交代（把话磨到能说出口）被逐段定位', narrIds(narr).filter((x) => x === 'deterministic:narrator-distance').length >= 2,
    JSON.stringify(narr.findings.map((f) => f.message)));
  ok('E10 叙述者越界（这个年纪遇到这种事）被逐段定位', narr.findings.some((f) => /叙述者越界/.test(f.message)));

  const narrOff = scanEditing(chanceText, { abilities: [], genre: 'general', task: 'review' });
  ok('E11 narrative-distance 默认关闭时不产生 finding（开关有真实输出差）',
    !narrIds(narrOff).includes('deterministic:narrator-distance'));

  const clicheText = [
    '他慢慢点了一下头。',
    '他慢慢点了一下头。',
    '“那我现在是什么。”',
    '“宿主。”',
  ].join('\n');
  const den = scanEditing(clicheText, { abilities: ['style-density'], genre: 'general', task: 'review' });
  ok('E12 同一个过渡动作写两遍 → 报重复（只报密度会漏，本章密度仅 0.2/千字）',
    den.findings.some((f) => f.rule_id === 'deterministic:gesture-cliche-repeat'));

  const placement = scanEditing([
    '剑在书包里，和卷子挤在一起。',
    '剑在书包夹层里，压在最底下。',
  ].join('\n'), { abilities: ['scene-logic'], genre: 'general', task: 'review' });
  ok('E13 同一物件的两个方位陈述 → 判为矛盾（零误报口径：只认明确陈述）',
    placement.findings.some((f) => f.rule_id === 'deterministic:object-placement-conflict'));

  const placementNeg = scanEditing([
    '侧袋里是水杯和伞。主袋里是卷子和错题本。',
    '再往里摸。指尖碰到一个硬的东西。',
    '书包搁在脚边，剑在主袋里，和卷子挤在一起。',
  ].join('\n'), { abilities: ['scene-logic'], genre: 'general', task: 'review' });
  ok('E14 动作句（再往里摸）与只有一处方位陈述时**不报**（误报比漏报更伤）',
    !placementNeg.findings.some((f) => f.rule_id === 'deterministic:object-placement-conflict'));

  const recall = scanEditing([
    '方的纸，0731。', '短信上是0731检测中心。', '他又看了一遍0731那几个数字。', '纸条上的0731和短信前面那四个一样。',
  ].join('\n'), { abilities: ['scene-logic'], genre: 'general', task: 'review' });
  ok('E15 同一编号被反复调出 → detail-recall（首次写足、之后只留关键连接）',
    recall.findings.some((f) => f.rule_id === 'deterministic:detail-recall'));
}

// ══════════════════ 隔离实例 ══════════════════
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NOVELSTUDIO_DATA_DIR: DATA_DIR,
    NOVELSTUDIO_OV_DISABLED: '1', // 本测试不涉及召回：只验证规则层与设置
    // 固定 X-Novel-Agent 头默认不再构成模型身份（见 server.js 的 isAgentRequest）；
    // 本测试要断言"模型侧只读/被拒不落库"，因此显式打开旧头兼容开关。
    NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
const cleanup = () => {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
};

async function jfetch(path, { method = 'GET', body, agent = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (agent) headers['X-Novel-Agent'] = '1';
  const res = await fetch(BASE + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { const r = await jfetch('/api/novel/ping', {}); if (r.status === 200) ready = true; } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000)); cleanup(); process.exit(2); }

try {
  console.log(`\n编辑规则隔离测试（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
  const w = (await jfetch('/api/works', { method: 'POST', body: { title: '编辑规则·甲书' } })).data.id;
  const c1 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: w, title: '第一章' } })).data.id;
  await jfetch('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: c1, content: '<p>他把斗篷挂好，屋里只有一盏灯。</p>' } });
  ok('准备：作品 + 章节 + 正文', !!(w && c1));

  // ── 默认：关闭（旧作品行为不变）──
  const off = (await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c1}&mode=full`)).data;
  ok('B1 默认关闭：assembled 里没有规则块（旧作品逐字节不变）',
    !String(off.assembled).includes('编辑保护规则') && off.edit_rules === null);
  const offManifest = (off.context_manifest || []).map((m) => m.id);
  ok('B2 默认关闭：manifest 里根本没有 edit_rules 这一层（不是 emitted:false）', !offManifest.includes('edit_rules'), JSON.stringify(offManifest));
  const baselineAssembled = String(off.assembled);

  // ── 打开：规则块进入请求 ──
  const saved = await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'deai', abilities: ['fiction-humanizer', 'chapter-hook'], genre: 'mystery', task: 'write' } });
  ok('B3 保存选择：回读一致（档位/能力/题材）',
    saved.status === 200 && saved.data.selection.tier === 'deai' && saved.data.selection.genre === 'mystery'
      && saved.data.selection.abilities.join(',') === 'fiction-humanizer,chapter-hook', JSON.stringify(saved.data.selection));
  const on = (await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c1}&mode=full`)).data;
  ok('B4 打开后：规则块真的进入 assembled（目标请求的提示词正文）',
    String(on.assembled).includes('编辑保护规则') && String(on.assembled).includes('能力·去 AI 腔') && String(on.assembled).includes('能力·章末钩子'));
  ok('B5 档位指令进入请求（去 AI 腔档）', String(on.assembled).includes('【编辑档位：去 AI 腔】'));
  ok('B6 题材侧重进入请求（悬疑档）', String(on.assembled).includes('题材侧重·悬疑'));
  ok('B7 规则层在 manifest 里可核对（含版本/hash）',
    (on.context_manifest || []).some((m) => m.id === 'edit_rules')
      && !!on.edit_rules && /^[0-9a-f]{16}$/.test(on.edit_rules.hash) && on.edit_rules.version === EDITING_RULE_VERSION);
  const contributions = (await jfetch(`/api/novel/context/contributions?work_id=${w}&chapter_id=${c1}`)).data.record;
  const layerEntry = contributions && contributions.entries.find((e) => e.source === 'host_context_layer' && e.rule_id === 'edit_rules');
  ok('B8 R05 贡献记录里有 layer:edit_rules 与内容 hash（规则版本可追踪）',
    !!layerEntry && /^[0-9a-f]{16}$/.test(layerEntry.content_hash) && layerEntry.chars > 0 && layerEntry.used === true,
    JSON.stringify(layerEntry || null));

  // ── 逐项能力 fixture：启用/关闭 ──
  // id → 进入规则块后的能力标题（rules.mjs 里写的是 `【${ability.name}】`）。
  // ⚠ 这张表必须覆盖 ABILITIES 全量：少一个 id 时 `abilityTexts[id]` 是 undefined，
  // `String(text).includes(undefined)` 恒为 false，那条 C 断言会以"能力没进块"的假象变红
  // （2026-10-02 新增三项能力时就发生过，同时 C 段的循环也把它们漏掉了）。
  const abilityTexts = {
    'fiction-humanizer': '能力·去 AI 腔',
    'narrative-distance': '能力·叙述距离',
    'scene-logic': '能力·场景逻辑',
    'dialogue-editor': '能力·对白编辑',
    'webnovel-pacing': '能力·网文节奏',
    'mystery-review': '能力·悬疑审视',
    'romance-review': '能力·感情线审视',
    'character-voice': '能力·角色声音',
    'chapter-hook': '能力·章末钩子',
    'style-density': '能力·结构密度',
    // 2026-10-08 第四批新增三项（同一次错误又发生了一遍：
    // 加了能力没加 fixture → C0 报"少一项"、三条 C 断言以"能力没进块"的假象变红）。
    'number-lock': '能力·数值一致性',
    'scene-bridge': '能力·转场桥',
    'promise-identity': '能力·体系辨识度',
    // 2026-10-08 第五批新增一项 —— 这是同一个错误在**同一个文件里第三次**发生
    // （2026-10-02、2026-10-08 第四批、2026-10-08 第五批）。注释拦不住人，靠下面的 C0b/C0c：
    // 前两次只留了注释，第三次照样漏。真正起作用的是"派生式护栏 + 跑一遍"。
    'story-shape': '能力·叙事结构',
  };
  ok('C0 逐项 fixture 覆盖目录全部能力（少一项就会以"没进块"的假象变红）',
    ABILITIES.every((a) => typeof abilityTexts[a.id] === 'string') && Object.keys(abilityTexts).length === ABILITIES.length,
    JSON.stringify({ abilities: ABILITIES.length, fixtures: Object.keys(abilityTexts).length }));
  // C0c（2026-10-08 第五批）：目录里的 `id` 与它的规则正文必须对得上。
  // C0b 只能验证"fixture 的文案在正文里"，验不了"正文里的能力名与 id 一致"——
  // 若有人把 `rule` 写成 `能力·叙事结构` 但 id 取 `story-shape-2`，C0b 照样绿。
  // ⚠️ 口径必须比"name 前缀完全相等"松：目录里有两条既有能力的 name 带后缀或长于正文
  //（`去 AI 腔（Humanizer）` 对正文 `能力·去 AI 腔`、`结构密度审视` 对正文 `能力·结构密度`），
  // 用相等口径会把它们误判成漂移（本条护栏第一版就是这么错的，用 14 项真实目录当场抓出）。
  // 正确的本意是：**正文里的能力名前 2 字必须与 name 的前 2 字一致**。
  // 逐个放宽到"完全包含"会再次误判（`结构密度审视` 不在正文 `能力·结构密度` 里——
  // 第二版口径就是这么错的），所以取"最短可辨前缀"这个更诚实的判据：
  // 它挡得住 id/名字/正文三者真正错位，又不强求两处文案逐字相同。
  const idNameMismatch = ABILITIES.filter((a) => {
    const name = String(a.name).replace(/（[^）]*）|\([^)]*\)/g, '').trim();
    const head = (String(a.rule).match(/^能力·([^：:（(]{2,})/) || [])[1] || '';
    return name.length < 2 || head.slice(0, 2) !== name.slice(0, 2);
  }).map((a) => `${a.id}: name「${a.name}」与规则正文开头对不上`);
  ok('C0c 每条能力的「能力·<name>」真的出现在它自己的规则正文开头（防止 id/名字/正文三者漂移）',
    idNameMismatch.length === 0, JSON.stringify(idNameMismatch));
  // C0b（2026-10-08 加的**派生式**护栏，专治"手写清单漏项"这一类反复出现的缺陷）：
  // 不再只数条数，而是要求 fixture 值真的出现在**真实目录**的能力规则正文里。
  // 这样"加了能力忘了加 fixture"会当场变红，而且不会因为两份手写清单**恰好同样漏了一项**而假绿
  // （那正是 C0 只比长度时的失效方式：abilities=13 / fixtures=10 能红，但如果两边都漏同一项就没事）。
  // ⚠️ 口径是**包含**而不是相等：目录里有的规则名带括号说明（`能力·叙述距离（谁的视角、…）`），
  // 而 `【${ability.name}】` 用的是短名 `叙述距离` —— 相等口径会把两条既有能力误判成不一致
  //（本条判据的第一版就是这么错的，用 13 项真实目录当场抓出）。
  const notInRule = ABILITIES.filter((a) => !String(a.rule).includes(abilityTexts[a.id] || '\u0000'))
    .map((a) => `${a.id}: fixture「${abilityTexts[a.id]}」不在规则正文里`);
  ok('C0b fixture 的文案真的出现在目录里对应能力的规则正文中（派生自查，防两份手写清单同时漏项）',
    notInRule.length === 0, JSON.stringify(notInRule));
  // 只挂 review 的能力：C 段必须用 review 任务跑，否则决策是 task_not_applicable（那是 A8 的管辖范围）
  const reviewOnly = new Set(ABILITIES.filter((a) => !(a.tasks || []).includes('write')).map((a) => a.id));
  for (const ability of ABILITIES) {
    const id = ability.id;
    const task = reviewOnly.has(id) ? 'review' : 'write';
    // 用一个能容纳该能力的题材档（悬疑能力亲和「悬疑」档、感情线能力亲和「言情」档）
    const genre = id === 'mystery-review' ? 'mystery' : id === 'romance-review' ? 'romance' : 'general';
    const put = await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'light', abilities: [id], genre, task } });
    const inBlock = String(put.data.block.text).includes(abilityTexts[id]);
    const othersText = Object.entries(abilityTexts).filter(([k]) => k !== id).map(([, v]) => v);
    ok(`C·${id} 启用后：只有该能力的规则进入规则块（任务/题材适用时）`,
      inBlock && othersText.every((t) => !String(put.data.block.text).includes(t)),
      JSON.stringify({ inBlock, decisions: put.data.block.decisions }));
  }
  // 关闭后不进入请求
  const cleared = await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'light', abilities: [], genre: 'general', task: 'write' } });
  ok('C·关闭能力：规则块只剩保护规则 + 档位（没有能力规则）',
    !/能力·/.test(String(cleared.data.block.text)) && String(cleared.data.block.text).includes('编辑保护规则'));
  // 题材不适用
  const hist = await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'light', abilities: ['webnovel-pacing'], genre: 'history', task: 'write' } });
  ok('C·题材不适用：能力被跳过并给出 decision 原因',
    !String(hist.data.block.text).includes('能力·网文节奏')
      && hist.data.block.decisions.some((d) => d.id === 'webnovel-pacing' && !d.load && d.reason === 'genre_not_applicable(history)'));
  // 关掉总开关 → 回到基线
  await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'deep', abilities: ['dialogue-editor'], genre: 'urban' } });
  const offAgain = await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: false, tier: 'deep', abilities: ['dialogue-editor'], genre: 'urban' } });
  ok('B9 关闭总开关：选择被如实保存（不是丢设置），且层不再进入上下文',
    offAgain.data.selection.enabled === false && offAgain.data.selection.tier === 'deep'
      && offAgain.data.selection.abilities.join(',') === 'dialogue-editor' && offAgain.data.selection.genre === 'urban');
  const back = (await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c1}&mode=full`)).data;
  ok('B10 关闭后 assembled 与默认基线逐字节一致（旧行为恢复）', String(back.assembled) === baselineAssembled);

  // ── D. 写入边界 ──
  const agentPut = await jfetch('/api/novel/editing', { method: 'PUT', agent: true, body: { enabled: true, tier: 'deep' } });
  ok('D1 模型侧不能改编辑规则开关（403，携带 X-Novel-Agent）', agentPut.status === 403, `实际 ${agentPut.status}`);
  const afterAgent = (await jfetch('/api/novel/editing')).data.selection;
  ok('D2 被拒后设置没有变化（拒绝不是"静默跳过"）', afterAgent.enabled === false, JSON.stringify(afterAgent));

  // ── E（HTTP）：扫描端点 ──
  await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'deai', abilities: ['fiction-humanizer', 'chapter-hook'], genre: 'general' } });
  const scan = await jfetch('/api/novel/editing/scan', { method: 'POST', body: { work_id: w, chapter_id: c1, text: '空气仿佛凝固了。\n重复的段落内容在这里出现。\n重复的段落内容在这里出现。' } });
  ok('E9 扫描端点返回结构化 finding（只含已启用能力）',
    scan.status === 200 && scan.data.findings.some((f) => f.rule_id === 'deterministic:ai-tell')
      && scan.data.findings.some((f) => f.rule_id === 'deterministic:duplicate-paragraph')
      && scan.data.selection.abilities.join(',') === 'fiction-humanizer,chapter-hook'
      && !scan.data.findings.some((f) => f.rule_id === 'deterministic:romance-tell'),
    JSON.stringify(scan.data.findings.map((f) => f.rule_id)));
  const scanAgent = await jfetch('/api/novel/editing/scan', { method: 'POST', agent: true, body: { work_id: w, chapter_id: c1, text: '「你来了。」' } });
  ok('E10 扫描是只读的：模型侧可以调用（不写数据、不改 Canon）', scanAgent.status === 200);
  const scanOther = await jfetch('/api/novel/editing/scan', { method: 'POST', body: { work_id: w, chapter_id: 999999 } });
  ok('E11 跨书/不存在的章节 → 404（不扫描别人的正文）', scanOther.status === 404, `实际 ${scanOther.status}`);
  // ── E04（2026-10-09）：叙事诊断的确定性候选层随扫描一起返回 ──
  // 只在作者启用 story-shape 时产出；`semantic_status` 恒为 not_run（界面不得显示"叙事诊断完成"）；
  // 且确定性层**只给 condense/check**，永不返回 delete（不定罪）。
  await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'deai', abilities: ['story-shape'], genre: 'general' } });
  const narrativeText = [
    '他不认识画面里那个女生。这道光柱和他没关系，这场雪和他也没关系。',
    '雪落在海澜市的中心广场上。落在写字楼的玻璃幕墙上。落在停着的公交车顶。落在通往港口的立交桥上。',
    '半座城市。',
    '上午十点前后，屏幕右上角换了行字。',
  ].join('\n\n');
  const nScan = await jfetch('/api/novel/editing/scan', { method: 'POST', body: { work_id: w, chapter_id: c1, text: narrativeText } });
  const narrative = nScan.data && nScan.data.narrative;
  ok('E12 启用 story-shape 时扫描返回叙事候选层（确定性候选，含数据不足字段）',
    nScan.status === 200 && !!narrative && Array.isArray(narrative.candidates)
      && narrative.deterministic === true && Array.isArray(narrative.insufficient_data)
      && nScan.data.narrative_status === 'not_run',
    JSON.stringify({ candidates: narrative && narrative.candidates.length, status: nScan.data.narrative_status }));
  ok('E13 叙事候选不定罪：只给 condense/check、requires_semantic_check 恒真、不带 delete',
    !!narrative && narrative.candidates.length > 0
      && narrative.candidates.every((x) => ['condense', 'check'].includes(x.suggested_action))
      && narrative.candidates.every((x) => x.requires_semantic_check === true)
      && narrative.candidates.every((x) => !!x.counterevidence_hint),
    JSON.stringify((narrative ? narrative.candidates : []).map((x) => x.rule_id)));
  await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'deai', abilities: ['fiction-humanizer'], genre: 'general' } });
  const nOff = await jfetch('/api/novel/editing/scan', { method: 'POST', body: { work_id: w, chapter_id: c1, text: narrativeText } });
  ok('E14 未启用 story-shape 时不返回叙事候选（不打开就不加调用与结论）',
    !(nOff.data && nOff.data.narrative) && nOff.data.narrative_status === 'not_requested',
    JSON.stringify({ has: !!(nOff.data && nOff.data.narrative), status: nOff.data.narrative_status }));

  // ── E03（2026-10-09）：审稿报告结构化（引用核验）+ 修稿选择记录 ──
  const realQuote = '他把斗篷挂好，屋里只有一盏灯。';
  const goodFinding = {
    id: 'N04', kind: 'narrative', severity: 'medium', verdict: 'confirmed',
    evidence: [{ quote: realQuote, source: 'body' }],
    reading_cost: '交代与后文重复', rationale: '这句已由动作表达',
    counterevidence: '若作者有意用静物收束段落，则不是冗余', suggested_action: 'condense',
  };
  const fakeFinding = { ...goodFinding, id: 'X9', evidence: [{ quote: '他把斗篷挂了起来。', source: 'body' }] };
  const reviewPut = await jfetch('/api/novel/review', {
    method: 'PUT',
    body: { work_id: w, chapter_id: c1, base_hash: 'fnv1a:test:10', report: { summary: '总评', issues: [], findings: [goodFinding, fakeFinding] } },
  });
  ok('E15 结构化审稿：引用能逐字定位的通过、定位不到的拒收并给出理由',
    reviewPut.status === 201 && reviewPut.data.structure === 'review_v2'
      && reviewPut.data.findings_accepted === 1 && reviewPut.data.findings_rejected === 1
      && /找不到/.test(String((reviewPut.data.rejected[0] || {}).errors || '').slice(0, 200)),
    JSON.stringify(reviewPut.data));
  const reviewGet = await jfetch(`/api/novel/review?chapter_id=${c1}`);
  const savedReport = (reviewGet.data.review || {}).report || {};
  ok('E15b 结构化结论随报告落库：兼容清单带 id 与引用，findings 可复核（拒收项不在清单里）',
    reviewGet.status === 200 && Array.isArray(savedReport.issues)
      && savedReport.issues.some((x) => String(x).includes('[N04]') && String(x).includes(realQuote.slice(0, 10)))
      && Array.isArray(savedReport.findings) && savedReport.findings.length === 1
      && !savedReport.issues.some((x) => String(x).includes('X9')),
    JSON.stringify({ issues: savedReport.issues, findings: (savedReport.findings || []).length }));

  const selPut = await jfetch('/api/novel/revision/selection', {
    method: 'PUT',
    body: { work_id: w, chapter_id: c1, review_id: reviewPut.data.review_id, snapshot_id: 'ch1@abc', base_hash: 'fnv1a:test:10', selection_hash: 'sel-aaa', plan_hash: 'plan-bbb', selected_issue_ids: ['1', '2'], source: 'ui' },
  });
  const selGet = await jfetch(`/api/novel/revision/selection?chapter_id=${c1}`);
  const sel = selGet.data.selection || {};
  ok('E16 修稿选择记录可独立复核：勾选集合、快照与两个 hash 都能读回',
    selPut.status === 201 && selPut.data.selected === 2
      && Array.isArray(sel.selected_issue_ids) && sel.selected_issue_ids.join(',') === '1,2'
      && sel.snapshot_id === 'ch1@abc' && sel.selection_hash === 'sel-aaa' && sel.plan_hash === 'plan-bbb'
      && Number(sel.review_id) === Number(reviewPut.data.review_id),
    JSON.stringify(sel));
  await jfetch('/api/novel/revision/selection', {
    method: 'PUT',
    body: { work_id: w, chapter_id: c1, snapshot_id: 'ch1@abc', base_hash: 'fnv1a:test:10', selection_hash: 'sel-ccc', selected_issue_ids: ['2'], source: 'ui' },
  });
  const selGet2 = await jfetch(`/api/novel/revision/selection?chapter_id=${c1}`);
  ok('E16b 选择记录是**每次发起修稿的输入快照**：取消一条后读到的是新的集合（不是旧的缓存）',
    (selGet2.data.selection || {}).selected_issue_ids.join(',') === '2'
      && (selGet2.data.selection || {}).selection_hash === 'sel-ccc');
  const selEmpty = await jfetch('/api/novel/revision/selection', {
    method: 'PUT', body: { work_id: w, chapter_id: c1, selected_issue_ids: [] },
  });
  ok('E17 空勾选被拒绝（没有选择就没有修稿依据，不能记一条什么都不含的记录）',
    selEmpty.status === 400, JSON.stringify(selEmpty.data));
  const selOther = await jfetch('/api/novel/revision/selection?chapter_id=999999');
  ok('E17b 不存在的章节：读选择记录返回空（不串到别的章）', selOther.status === 200 && selOther.data.selection === null);

  // E06：三类证据的对照数据（只给原始计数；比例是否可看由界面按样本量守卫决定）
  const cmp = await jfetch(`/api/novel/revision/comparison?chapter_id=${c1}`);
  const cm = cmp.data.model || {};
  const ch = cmp.data.human || {};
  ok('E18 对照视图返回三类证据：模型诊断 / 人工复判 / 结构指标 + 原始样本计数',
    cmp.status === 200 && Number(cm.reviews) >= 1 && !!cm.latest
      && cm.latest.structure === 'review_v2' && Number(cm.latest.findings) === 1 && Number(cm.latest.findings_rejected) === 1
      && Number(ch.selections) === 2 && Number(cmp.data.sample_inputs.reviews) === Number(cm.reviews)
      && Number(cmp.data.sample_inputs.runs) === Number(ch.selections),
    JSON.stringify({ model: cm.latest, human: ch, sample: cmp.data.sample_inputs }));
  const st = cmp.data.structure || {};
  ok('E18b 结构指标来自确定性测量（段落/字数/对白占比/候选数），且不掺语义结论',
    Number(st.paragraphs) >= 1 && Number(st.chars) > 0 && Number.isFinite(Number(st.dialogue_ratio))
      && Number.isFinite(Number(st.narrative_candidates)),
    JSON.stringify(st));
  const cmpOther = await jfetch('/api/novel/revision/comparison?chapter_id=999999');
  ok('E18c 不存在的章节 → 404（对照不跨章）', cmpOther.status === 404);

  // ── E02（2026-10-09）：直连与 Harness 的**同阶段等价**（路由输入级证据） ──
  // 两条通道各自取上下文：直连走 /api/ai_context（前端 loadAIContext），Harness 走 /api/novel/context
  // （插件 novel_write_pipeline，现在带 stage=draft）。这里同参数对照两条端点的实际装配结果与规则块元信息。
  await jfetch('/api/novel/editing', { method: 'PUT', body: { enabled: true, tier: 'deai', abilities: ['fiction-humanizer'], genre: 'general' } });
  const draftNovel = await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c1}&mode=full&tools=0&stage=draft`);
  const draftAi = await jfetch(`/api/ai_context?chapter_id=${c1}&tools=0&stage=draft`);
  ok('E19 同一阶段两条端点给出同一份装配与同一规则块 hash（直连 vs Harness 等价）',
    draftNovel.status === 200 && draftAi.status === 200
      && typeof draftNovel.data.assembled === 'string' && draftNovel.data.assembled === draftAi.data.assembled
      && !!draftNovel.data.edit_rules && draftNovel.data.edit_rules.hash === draftAi.data.edit_rules.hash
      && draftNovel.data.edit_rules.stage === 'draft',
    JSON.stringify({
      sameAssembled: draftNovel.data.assembled === draftAi.data.assembled,
      novelHash: draftNovel.data.edit_rules && draftNovel.data.edit_rules.hash,
      aiHash: draftAi.data.edit_rules && draftAi.data.edit_rules.hash,
      stage: draftNovel.data.edit_rules && draftNovel.data.edit_rules.stage,
    }));
  const draftText = String(draftNovel.data.assembled || '');
  ok('E19b draft 阶段只给生成期许可：不含诊断判据与逐项评分任务',
    draftText.includes('生成期·只给正向许可') && draftText.includes('这一阶段不做逐项评分')
      && !draftText.includes('诊断期·完整判据') && !draftText.includes('逐处识别机械表达，每条都要给出'),
    'len=' + draftText.length);
  const verifyStage = await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c1}&mode=full&tools=0&stage=verify_style`);
  const verifyText = String(verifyStage.data.assembled || '');
  ok('E19c verify_style 阶段给完整判据 + 反证要求（证明两阶段确实不同，不是都为空）',
    verifyText.includes('诊断期·完整判据') && verifyText.includes('反证')
      && verifyText !== draftText
      && (verifyStage.data.edit_rules || {}).hash !== (draftNovel.data.edit_rules || {}).hash,
    JSON.stringify({ verifyStage: (verifyStage.data.edit_rules || {}).stage }));
  const legacyStage = await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c1}&mode=full&tools=0`);
  const legacyText = String(legacyStage.data.assembled || '');
  ok('E19d 不传阶段 = 旧行为（基础规则文本），且与 draft 变体不同（阶段确实生效过）',
    legacyText !== draftText && legacyText.includes('能力·去 AI 腔：逐处识别机械表达'),
    JSON.stringify({ legacyStage: (legacyStage.data.edit_rules || {}).stage || '(空=基础)' }));
  // 「明确事实限制仍在」分两层验：
  //   · 装配层：三个阶段都仍带**写作红线**层（作品级显式事实限制的承载层）；
  //   · 提示词层：直连提示词（frontend-test 94S）与 Harness 预设（verify-plugin-tools）都仍写明
  //     "不要编造与既有设定冲突的内容"——那两处才是这句话真正落地的位置。
  ok('E19e 三个阶段都仍带写作红线层（作品级显式事实限制没有被阶段化吃掉）',
    [draftText, verifyText, legacyText].every((t) => /红线/.test(t)),
    JSON.stringify({ draft: /红线/.test(draftText), verify: /红线/.test(verifyText), legacy: /红线/.test(legacyText) }));
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
} finally {
  cleanup();
}

console.log(`\n编辑规则（R07）：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
