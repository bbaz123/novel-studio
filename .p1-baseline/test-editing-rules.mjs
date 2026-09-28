#!/usr/bin/env node
/**
 * test-editing-rules.mjs —— R07「三档编辑 + 编辑保护规则 + 七项能力 + 题材档」隔离测试（零计费）。
 *
 * 覆盖（任务书 §10.3 的验收判据，逐条落到断言）：
 *   A. 纯模块：目录/版本/hash 稳定；白名单解析（未知 tier/能力/题材如实回报且不采用）；
 *      保护规则在所有档位都在；能力按任务与题材决定是否加载；同一选择 → 同一 hash（确定性）。
 *   B. 请求可见性：打开开关后规则块真的进入 `/api/novel/context` 的 assembled（=目标请求的提示词正文），
 *      关闭后**不进入**（且 assembled 与基线逐字节一致）；R05 贡献记录里有 layer:edit_rules 与内容 hash。
 *   C. 能力逐项 fixture：七项能力各自「启用→进入请求 / 关闭→不进入」；
 *      「题材不适用 → 不加载」有明确 decision 原因（genre_not_applicable）。
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
  ok('A1 目录：三档 + 七项能力 + 七题材 + 保护规则，且都带版本/hash',
    catalog.tiers.length === 3 && catalog.abilities.length === 7 && catalog.genres.length === 7
      && catalog.version === EDITING_RULE_VERSION
      && [...catalog.tiers, ...catalog.abilities, ...catalog.genres, catalog.protection].every((r) => /^[0-9a-f]{16}$/.test(r.hash) && r.version === EDITING_RULE_VERSION),
    JSON.stringify({ tiers: catalog.tiers.length, abilities: catalog.abilities.length, genres: catalog.genres.length }));
  ok('A2 七项能力 id 与任务书一致（命名自由，能力覆盖不可少）',
    ['fiction-humanizer', 'dialogue-editor', 'webnovel-pacing', 'mystery-review', 'romance-review', 'character-voice', 'chapter-hook']
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
      && off.skipped.every((s) => s.reason === 'disabled') && off.skipped.length === 7);
  ok('E8 与档位无关的重复检测在关闭能力时仍然工作', ids(off).includes('deterministic:duplicate-paragraph'));
}

// ══════════════════ 隔离实例 ══════════════════
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NOVELSTUDIO_DATA_DIR: DATA_DIR,
    NOVELSTUDIO_OV_DISABLED: '1', // 本测试不涉及召回：只验证规则层与设置
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
  const abilityTexts = {
    'fiction-humanizer': '能力·去 AI 腔',
    'dialogue-editor': '能力·对白编辑',
    'webnovel-pacing': '能力·网文节奏',
    'mystery-review': '能力·悬疑审视',
    'romance-review': '能力·感情线审视',
    'character-voice': '能力·角色声音',
    'chapter-hook': '能力·章末钩子',
  };
  const reviewOnly = new Set(['mystery-review', 'romance-review']);
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
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
} finally {
  cleanup();
}

console.log(`\n编辑规则（R07）：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
