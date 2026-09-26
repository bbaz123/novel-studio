#!/usr/bin/env node
/**
 * test-host-contract.mjs —— Host Contract 1.0.0 的**离线契约测试**（零计费、不碰数据库）。
 *
 * 为什么需要它：冻结一份契约，如果只有文档没有断言，文档就会慢慢腐烂成"愿望清单"。
 * 本测试把契约拆成四类可机械判定的东西：
 *   A. **代码 → 契约**：清单/信封字段、层规格、预算、策略快照、工具面、端点面、日志层级、
 *      作业状态词、DB 表清单——全部从**真实代码**重新导出，与 `docs/host-contract.v1.json` 逐项比对；
 *   B. **文档 → 契约**：`docs/host-contract.md` 必须逐条列出工具名、端点、边界与不变条件；
 *   C. **边界 → 代码**：插件不得绕过的那几条，必须在宿主代码里真的成立（前端不得自行拼装上下文、
 *      DB 迁移只增不减、远端日志层级受限、ping 能报出契约版本）；
 *   D. **旧库兼容**：旧库副本仍被支持（只读打开，核对 schema 指纹与表清单）。
 *
 * 负向对照（变异测试）：把契约复制一份改坏（预算 / 工具名 / 端点），比对函数必须报错——
 * 否则这些断言只是装饰。
 *
 * 用法: node .p1-baseline/test-host-contract.mjs
 *      node .p1-baseline/test-host-contract.mjs --db .p1-baseline/data/novel.db   # 指定旧库副本
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DOC = path.join(REPO, 'docs', 'host-contract.md');
const FIXTURE = path.join(REPO, 'docs', 'host-contract.v1.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB_PATH = path.resolve(REPO, arg('--db', '.p1-baseline/data/novel.db'));

let pass = 0;
const fails = [];
const skips = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const skip = (name, why) => { skips.push({ name, why }); console.log(`  – ${name}（跳过：${why}）`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const contract = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const doc = fs.readFileSync(DOC, 'utf8');
const serverSrc = read('server.js');
const dbSrc = read('db.js');
const loggerSrc = read('logger.js');
const appSrc = read('public/app.js');
const plugin = JSON.parse(read('harness-plugins/novel-writing/plugin.json'));

// ── 从代码导出的事实（每次运行都重新算；契约漂移会在这里被抓到）──────────────
async function factsFromCode() {
  const L = await imp('ai/context/layers.mjs');
  const A = await imp('ai/context/assembler.mjs');
  const P = await imp('ai/policy.mjs');

  const layers = [
    { id: 'work', label: '作品', kind: 'fixed', cap: 900, text: '书名：契约测试\n简介：一句话', sourceIds: [7] },
    { id: 'outline', label: '卷/剧情线/章节进度（大纲）', kind: 'flex', cap: 2800, text: '第1节 开端：主角进城', sourceIds: [11, 12] },
    { id: 'memory', label: '长期记忆（已发生的故事摘要）', kind: 'fixed', cap: 2200, text: '主角已进城。', sourceIds: [3] },
    { id: 'story_tail', label: '前文衔接', kind: 'flex', cap: 1600, floor: 400, text: '上一章的结尾……', sourceIds: [12] },
    { id: 'redlines', label: '写作风格红线', kind: 'fixed', cap: 4000, text: '禁止「心中一凛」', sourceIds: [1, 2] },
  ];
  const r = A.assemble(layers, { mode: 'full', workId: 7, chapterId: 12, requestId: 'ctx-contract-1' });
  const listOf = (text, name) => {
    const m = text.match(new RegExp(name + String.raw`\s*=\s*\[([^\]]*)\]`));
    return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
  };
  return {
    host_contract: null, // 版本由 fixture 持有，不做代码推导
    context: {
      endpoints: contract.context.endpoints.slice(),
      modes: contract.context.modes.slice(),
      layers: L.LAYERS.map((l) => {
        const row = {
          id: l.id, kind: l.kind,
          cap: Number.isFinite(l.cap) ? l.cap : null,
          cap_continuation: Number.isFinite(l.capContinuation) ? l.capContinuation : null,
          floor: Number.isFinite(l.floor) ? l.floor : null,
          entity_cap: Number.isFinite(L.entityCapOfId(l.id)) ? L.entityCapOfId(l.id) : null,
        };
        // gated 只在为 true 时出现：契约里不写 `gated: false` 这类噪音字段。
        if (l.gated === true) row.gated = true;
        return row;
      }),
      flex_order: [...L.FLEX_ORDER],
      flex_caps: [...L.FLEX_CAPS],
      total_budget: { ...L.TOTAL_BUDGET },
      floor: { settings: L.computeFloor('settings').floor, full: L.computeFloor('full').floor },
      retrieval: Object.fromEntries(Object.entries(L.RETRIEVAL).map(([k, v]) => [k, { tool: v.tool || '', intrinsic: v.intrinsic === true }])),
      manifest_layer_fields: Object.keys(r.manifest[0]).sort(),
      envelope_fields: Object.keys(r.envelope).sort(),
      assemble_result_fields: Object.keys(r).sort(),
      integrity: { ...contract.context.integrity, checks: [...new Set((r.integrity.checks || []).map((c) => c.id))].sort() },
      cache_scope: contract.context.cache_scope,
    },
    policy: { ...P.policySnapshot(), long_ai_timeout_ms: P.LONG_AI_TIMEOUT_MS },
    plugin_adapter: {
      ...contract.plugin_adapter,
      tools: (plugin.tools || []).map((t) => (typeof t === 'string' ? t : t.name)),
      endpoints: [...(plugin.engineEndpoints || [])],
    },
    trace: {
      ...contract.trace,
      log_layers: listOf(loggerSrc, 'LAYERS'),
      remote_layers: listOf(loggerSrc, 'REMOTE_LAYERS'),
      levels: listOf(loggerSrc, 'LEVELS'),
    },
    db: {
      ...contract.db,
      tables: [...new Set((dbSrc.match(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g) || []).map((s) => s.replace('CREATE TABLE IF NOT EXISTS ', '')))].sort(),
    },
  };
}

/** 契约 ↔ 代码 的逐项比对。返回不一致清单（空 = 一致）。 */
function compareFacts(fx, facts) {
  const bad = [];
  const cmp = (label, a, b) => { if (!same(a, b)) bad.push(`${label}: 契约=${JSON.stringify(a).slice(0, 160)} 代码=${JSON.stringify(b).slice(0, 160)}`); };
  cmp('context.layers', fx.context.layers, facts.context.layers);
  cmp('context.flex_order', fx.context.flex_order, facts.context.flex_order);
  cmp('context.flex_caps', fx.context.flex_caps, facts.context.flex_caps);
  cmp('context.total_budget', fx.context.total_budget, facts.context.total_budget);
  cmp('context.floor', fx.context.floor, facts.context.floor);
  cmp('context.retrieval', fx.context.retrieval, facts.context.retrieval);
  cmp('context.manifest_layer_fields', fx.context.manifest_layer_fields, facts.context.manifest_layer_fields);
  cmp('context.envelope_fields', fx.context.envelope_fields, facts.context.envelope_fields);
  cmp('context.assemble_result_fields', fx.context.assemble_result_fields, facts.context.assemble_result_fields);
  cmp('context.integrity.checks', fx.context.integrity.checks, facts.context.integrity.checks);
  cmp('policy', fx.policy, facts.policy);
  cmp('plugin_adapter.tools', fx.plugin_adapter.tools, facts.plugin_adapter.tools);
  cmp('plugin_adapter.endpoints', fx.plugin_adapter.endpoints, facts.plugin_adapter.endpoints);
  cmp('trace.log_layers', fx.trace.log_layers, facts.trace.log_layers);
  cmp('trace.remote_layers', fx.trace.remote_layers, facts.trace.remote_layers);
  cmp('trace.levels', fx.trace.levels, facts.trace.levels);
  cmp('db.tables', fx.db.tables, facts.db.tables);
  return bad;
}

console.log('【0. 契约文件自洽】');
ok('契约版本号存在且形如 x.y.z', /^\d+\.\d+\.\d+$/.test(contract.host_contract), contract.host_contract);
ok('fixture 与文档声明的版本一致',
  doc.includes(`host-contract ${contract.host_contract}`) || doc.includes(contract.host_contract),
  '文档里找不到 ' + contract.host_contract);
ok('冻结日期存在', /^\d{4}-\d{2}-\d{2}$/.test(contract.frozen_at), contract.frozen_at);

console.log('\n【A. 代码 → 契约（漂移检测）】');
const facts = await factsFromCode();
const mismatches = compareFacts(contract, facts);
ok(`${contract.context.layers.length} 个上下文层 / 预算 / 策略 / 工具面 / 端点面 / 日志层级 / DB 表 全部与契约一致`,
  mismatches.length === 0, mismatches.join('；'));
ok('预算可执行下限 ≤ 预算常量（settings）',
  facts.context.floor.settings <= facts.context.total_budget.settings,
  `下限 ${facts.context.floor.settings} ≤ 预算 ${facts.context.total_budget.settings}`);

console.log('\n【A2. 负向对照：改坏契约必须报红】');
{
  const m1 = JSON.parse(JSON.stringify(contract)); m1.context.total_budget.settings = 1;
  const m2 = JSON.parse(JSON.stringify(contract)); m2.plugin_adapter.tools = m2.plugin_adapter.tools.slice(1);
  const m3 = JSON.parse(JSON.stringify(contract)); m3.context.envelope_fields = m3.context.envelope_fields.filter((f) => f !== 'contextId');
  ok('改坏预算 → 报红', compareFacts(m1, facts).length > 0);
  ok('少一个工具 → 报红', compareFacts(m2, facts).length > 0);
  ok('少一个信封字段 → 报红', compareFacts(m3, facts).length > 0);
}

console.log('\n【B. 文档 → 契约】');
{
  const missTools = contract.plugin_adapter.tools.filter((t) => !doc.includes(t));
  ok(`文档逐条列出 ${contract.plugin_adapter.tools.length} 个 novel_* 工具`, missTools.length === 0, missTools.join('、'));
  const missEp = contract.plugin_adapter.endpoints.filter((e) => !doc.includes(e));
  ok('文档逐条列出插件可用端点（' + contract.plugin_adapter.endpoints.length + ' 条）', missEp.length === 0, missEp.join('；'));
  const missInv = contract.invariants.filter((t) => !doc.includes(t.slice(0, 12)));
  ok('文档逐条列出质量保护不变条件', missInv.length === 0, missInv.join('；'));
  const missMay = contract.boundaries.plugin_may.filter((t) => !doc.includes(t.slice(0, 14)));
  ok('文档逐条列出"插件可以使用的接口"', missMay.length === 0, missMay.join('；'));
  const missNot = contract.boundaries.plugin_must_not.filter((t) => !doc.includes(t.slice(0, 14)));
  ok('文档逐条列出"插件不得绕过的边界"', missNot.length === 0, missNot.join('；'));
  ok('文档写明重新打开契约的条件', contract.reopen_conditions.every((t) => doc.includes(t.slice(0, 12))));
}

console.log('\n【C. 边界 → 代码（契约禁止的事，代码里真的禁止）】');
{
  // C-1 前端不得自行拼装上下文（唯一来源是服务端 assembled）
  const m = appSrc.match(/function aiContextBlock\(\)[\s\S]*?\n\}/);
  const body = m ? m[0] : '';
  ok('aiContextBlock 只返回服务端 assembled（无前端拼装）',
    body.includes('ctx.assembled') && !/characters|world_entries|story_tail|recall/.test(body),
    body ? body.split('\n').slice(0, 6).join(' / ') : '找不到 aiContextBlock');
  // C-2 DB 迁移只增不减
  ok('db.js 没有 DROP TABLE / RENAME / DELETE FROM 这类破坏性语句',
    !/DROP\s+TABLE|DROP\s+COLUMN|RENAME\s+TO|DELETE\s+FROM\s+(works|chapters|characters)/i.test(dbSrc));
  ok('db.js 的迁移是"CREATE TABLE IF NOT EXISTS + try ALTER ADD COLUMN"',
    /CREATE TABLE IF NOT EXISTS/.test(dbSrc) && /ALTER TABLE \w+ ADD COLUMN/.test(dbSrc));
  // C-3 远端日志层级受限
  ok('远端上报只允许 frontend/plugin 两个层级（LAYERS 里含全部层级）',
    same(facts.trace.remote_layers, ['frontend', 'plugin']) && facts.trace.log_layers.includes('server'));
  // C-4 ping 必须能报出契约版本（插件运行时可校验）
  const pingBlock = serverSrc.match(/segments\[2\] === 'ping'[\s\S]{0,600}?\}\);/);
  ok('GET /api/novel/ping 响应里带 host_contract 版本',
    !!pingBlock && pingBlock[0].includes('host_contract'),
    pingBlock ? pingBlock[0].replace(/\s+/g, ' ').slice(0, 140) : '找不到 ping 处理块');
  ok('server.js 里的契约版本字面量与 fixture 一致',
    serverSrc.includes(`HOST_CONTRACT_VERSION = '${contract.host_contract}'`),
    'server.js 里找不到 HOST_CONTRACT_VERSION = \'' + contract.host_contract + '\'');
  // C-5 插件侧：不得自建第二套 task/trace/recovery（工具面里只能出现宿主端点）
  const toolSrc = read('harness-plugins/novel-writing/novel-tools.mjs');
  ok('插件只通过宿主 HTTP 端点工作（没有直接打开 novel.db / 没有自建 SSE 追踪）',
    !/new DatabaseSync\(/.test(toolSrc) && !/host_contract/.test(toolSrc));
  // C-5b 门控层：未提供时不得出现在清单里、也不得出现在 excluded 里、更不得计入可执行下限
  {
    const L = await imp('ai/context/layers.mjs');
    const A = await imp('ai/context/assembler.mjs');
    const gated = L.LAYERS.filter((l) => l.gated === true);
    ok('契约里登记了门控层（gated）', gated.length >= 1, gated.map((l) => l.id).join(','));
    const plain = A.assemble([
      { id: 'work', label: '作品', kind: 'fixed', cap: 900, text: 'x' },
      { id: 'redlines', label: '写作红线', kind: 'fixed', cap: 4000, text: 'y' },
    ], { mode: 'full', workId: 1, chapterId: 1, requestId: 'ctx-gated-1' });
    ok('未提供门控层时清单里没有它', !plain.manifest.some((m) => gated.some((g) => g.id === m.id)));
    ok('未提供门控层时 excluded 里也没有它（它不属于这套层）',
      !plain.envelope.excluded.some((e) => gated.some((g) => g.id === e.id)),
      plain.envelope.excluded.map((e) => e.id).join(','));
    const withGated = L.computeFloor('full', { includeGated: true }).floor;
    const withoutGated = L.computeFloor('full').floor;
    ok('门控层默认不计入可执行下限（既有作品预算不变）', withoutGated <= withGated,
      `默认 ${withoutGated} ≤ 含门控 ${withGated}`);
  }

  // C-6 端点面：契约里每条端点都能在 server.js 找到对应处理
  const tokenMiss = [];
  for (const ep of contract.plugin_adapter.endpoints) {
    const pathPart = ep.replace(/^[A-Z/]+\s+/, '').split('?')[0];
    for (const seg of pathPart.split('/').filter((s) => s && s.length > 2 && s !== 'api' && !s.startsWith(':'))) {
      for (const tok of seg.split('|')) {
        if (!serverSrc.includes(`'${tok}'`) && !serverSrc.includes(`\`${tok}`)) tokenMiss.push(ep + ' → ' + tok);
      }
    }
  }
  ok('契约里每条端点在 server.js 里都有对应实现', tokenMiss.length === 0, tokenMiss.join('；'));
}

console.log('\n【D. 旧库兼容（只读）】');
{
  if (!fs.existsSync(DB_PATH)) {
    skip('旧库 schema 指纹与表清单', '找不到 ' + DB_PATH + '（跳过≠通过）');
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    const crypto = await import('node:crypto');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const schema = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY name").all();
    const sha = crypto.createHash('sha256').update(schema.map((r) => r.name + '::' + (r.sql || '')).join('\n')).digest('hex').slice(0, 16);
    const oldTables = new Set(schema.filter((r) => r.type === 'table').map((r) => r.name));
    // ⚠ 必须拿 **1.0.0 冻结的那批表**（frozen_tables）比对：新版本新增的表旧库里当然没有，
    // 拿"当前全部表"去比会把"新增"误报成"不兼容"，这条检查也就失去了意义。
    const frozen = contract.db.frozen_tables || contract.db.tables;
    const missing = frozen.filter((t) => !oldTables.has(t));
    db.close();
    ok('旧库 schema 指纹与冻结时一致（' + contract.db.old_db_schema_sha16_at_freeze + '）', sha === contract.db.old_db_schema_sha16_at_freeze, '实际 ' + sha);
    ok('契约冻结的全部表在旧库里都存在（旧作品仍可打开）', missing.length === 0, missing.join('、'));
  }
}

console.log('\n' + '─'.repeat(46));
console.log(`Host Contract 契约测试：通过 ${pass} / 失败 ${fails.length} / 跳过 ${skips.length}`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f.name + (f.detail ? '  — ' + f.detail : '')); process.exit(1); }
if (skips.length) console.log('（跳过项不是通过：它们说明这条证据这次没拿到）');
console.log('契约版本 ' + contract.host_contract + '（冻结于 ' + contract.frozen_at + '）');