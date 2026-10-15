/**
 * tests/nsdsh/regression-findings.test.mjs —— S02：F01–F12 / D1–D6 的**行为表征**（characterization）。
 *
 * 目的不是"证明代码是对的"，而是**钉住现在真实会发生的每一件事**——包括已知缺陷。
 * 后面的修复阶段（S03–S14）改动行为时，必须先有意识地改这条断言，而不是让缺陷静默漂移、
 * 或者让"修好了"和"改坏了"长得一模一样。所以：
 *   · 当前行为就是缺陷的（F01–F04、F05–F09、F10–F12、D1–D6），断言**缺陷存在**，并注明修复阶段；
 *   · 断言里不做任何"应该怎样"的推断——做不到的就如实标 [静态]，不假装跑过。
 *
 * 每条标签都标了断言方式，读的人不需要猜：
 *   [动态]   真的在隔离临时库里跑了被测代码（内核行为）；
 *   [schema] 查真实临时库（PRAGMA / sqlite_master），不是"我记得应该是这样"；
 *   [静态]   只读源码或仓库文件的文本。
 *
 * 为什么部分条目只做静态断言：`server.js` / `harness.js` 在 import 时会解析数据目录、
 * 注册路由、读写作者的真实 DSH 设置，**不能**为了跑一条断言而 import 它们；
 * 被断言的只是文本里那几行确定事实，不含推断（D1 还额外做了内核层的动态复现）。
 *
 * 隔离纪律（本项目踩过的顺序坑）：必须在 import db.js / ai/** **之前**调用
 * makeIsolatedEnv().install() —— 那些模块在 import 时就解析数据目录并打开库。
 * 零计费：没有任何真实模型调用（分析用例注入确定性 fake generate）；
 * 零网络；不 spawn 子进程；绝不读写 <repo>/data。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, makeIsolatedEnv } from '../../scripts/nsdsh/lib/isolate.mjs';

// ── 硬闸 ①：先记下"装隔离之前"的系统临时根，再装环境 ────────────────────────────
// 为什么先取：install() 会把 TMPDIR/TEMP/TMP 改写成隔离目录里的 tmp/；而 assertIsolated()
// 是在 install **之后**再算一次 os.tmpdir() 的（它在 libuv 已缓存时才恰好相等）。这里把判据
// 钉在"装隔离之前那个真实临时根"上，规则与 assertIsolated 等价，但不依赖缓存行为。
const OS_TMP_ROOT = path.resolve(os.tmpdir());
const env = makeIsolatedEnv({ label: 'nsdsh-regression-findings-' }).install();
const ISOLATED_DATA_DIR = process.env.NOVELSTUDIO_DATA_DIR || '';
if (!ISOLATED_DATA_DIR) {
  throw new Error('未建立隔离环境：NOVELSTUDIO_DATA_DIR 为空，拒绝 import db.js（会打开真实库）');
}
if (path.resolve(ISOLATED_DATA_DIR).toLowerCase() === path.resolve(REPO, 'data').toLowerCase()) {
  throw new Error(`拒绝把测试数据目录指向真实库：${ISOLATED_DATA_DIR}`);
}
if (!path.resolve(ISOLATED_DATA_DIR).toLowerCase().startsWith(OS_TMP_ROOT.toLowerCase())) {
  throw new Error(`测试数据目录必须位于系统临时目录内（${OS_TMP_ROOT}），实际为 ${ISOLATED_DATA_DIR}`);
}
console.log(`  · 隔离数据目录：${ISOLATED_DATA_DIR}`);

// 顺序纪律：这里才开始接触会在 import 时解析数据目录的模块。
const T = await import('../../ai/story-state/temporal/index.mjs');
const { db } = await import('../../db.js');

/** 读仓库内文本文件（只读，不写）。 */
function readRepo(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}
/** 截取 [startNeedle, endNeedle] 之间的源码文本；找不到就响亮失败（不做静默降级）。 */
function sliceBetween(text, startNeedle, endNeedle) {
  const i = text.indexOf(startNeedle);
  assert.ok(i >= 0, `源码里找不到起点：${startNeedle}`);
  const j = text.indexOf(endNeedle, i + startNeedle.length);
  assert.ok(j > i, `源码里找不到终点：${endNeedle}`);
  return text.slice(i, j + endNeedle.length);
}
/** 临时库的真实表清单。 */
function tableNames() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
}
/** 按扩展名递归收集生产代码（跳过 node_modules / data / 点开头的侦察与基线目录）。 */
function walkCodeFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'data' || entry.name.startsWith('.')) continue;
      walkCodeFiles(full, out);
      continue;
    }
    if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const relOf = (abs) => path.relative(REPO, abs).split(path.sep).join('/');

/** 生产代码语料（跳过 tests/ 与点开头的基线/侦察目录）：供 D3 / D6 的"零读取者/零处理点"核查。 */
const PRODUCTION_CODE_FILES = walkCodeFiles(REPO).filter((f) => !relOf(f).startsWith('tests/'));

// ── 建库小夹具（与 tests/temporal/harness.mjs 同一手法，只保留本套件要用的最小形状）──
const now = () => new Date().toISOString();
function seedWork(title) {
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(title, now(), now());
  return Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
}
function seedChapter(workId, title, position = 0) {
  db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workId, title, '', position, now(), now());
  return Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
}
/** 一个开启时态引擎、有正文修订与 pending 保存提案的章节。 */
function seedTemporalChapter(workTitle, plainText, position = 0) {
  const workId = seedWork(workTitle);
  const chapterId = seedChapter(workId, '第一章', position);
  T.setTemporalConfig(workId, { temporal_enabled: true });
  const saved = T.recordContentSave({ workId, chapterId, contentHtml: `<p>${plainText}</p>` });
  assert.equal(saved.recorded, true, `前置：正文必须真的落成修订（${JSON.stringify(saved)}）`);
  return { workId, chapterId, saved };
}
/** 一个"可确认"的事件：新 cell（expected missing）+ 正文里找得到的引文。 */
function validEvent(plainText, entityId = '甲') {
  return {
    cursor: { chapter_index: 0 },
    ops: [{
      type: 'set',
      cell: { domain: 'character', entityId, predicate: 'alive', scope: 'canon' },
      expected: { kind: 'missing' },
      value: true,
    }],
    evidence: [{ quote: plainText, narrative: 'present' }],
  };
}

/** 顺序执行（含异步）用例；任一失败 → 进程非零退出。与 stage-runner 的套件形状一致。 */
async function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

const serverSrc = readRepo('server.js');

await suite('nsdsh/regression-findings', [
  // ────────────────────────────────────────────────────────────────────────────
  // F01 调度状态只在进程内 Map / setTimeout；数据库里没有对应的队列表（→ S04）
  // ────────────────────────────────────────────────────────────────────────────
  ['F01 [静态+schema] 分析调度必须有持久化载体（S04 已建表；server.js 尚未接线）', () => {
    // S04 起：队列的**持久化载体**已经建出来了 —— 这是 F01 修复的第一半。
    const tables = tableNames();
    assert.ok(tables.length > 40, `临时库应当建出全部表，实际 ${tables.length} 张`);
    const queueLike = tables.filter((t) => /(temporal|analysis)/i.test(t) && /(queue|job|task|schedul|run)/i.test(t));
    assert.ok(queueLike.includes('story_analysis_tasks'),
      `F01 已修（第一半）：必须存在持久化分析任务表，实际 ${queueLike.join(', ')}`);
    assert.ok(tables.includes('story_analysis_attempts'), 'F01：每次尝试也要留账（租约/代际审计）');
    // 关键列必须在：没有 lease / fencing 就只是"一张表"，不算可恢复队列。
    const cols = db.prepare('PRAGMA table_info(story_analysis_tasks)').all().map((c) => c.name);
    for (const c of ['lease_owner', 'lease_generation', 'lease_expires_at_ms', 'transport_state', 'not_before_ms', 'max_wait_ms', 'revision_id']) {
      assert.ok(cols.includes(c), `F01：story_analysis_tasks 必须含列 ${c}`);
    }

    // 阴性对照：其它子系统**本来就有**持久化排队表 —— 说明"有队列表"在这个仓库里是常态，
    // 上面对 story_analysis_tasks 的要求不是凭空加码。
    assert.ok(tables.includes('harness_jobs'), '对照：harness_jobs 是持久化作业表');
    assert.ok(tables.includes('story_repair_runs'), '对照：story_repair_runs 是持久化运行表');
    assert.ok(tables.includes('projection_outbox'), '对照：projection_outbox 是可恢复 outbox');

    // ⚠️ 第二半（**生产接线**）尚未完成：server.js 里仍是进程内 Map + setTimeout。
    // 这里刻意把"仍未接线"也钉住，避免"只建了表"就被当成 F01 已经修好。
    assert.match(serverSrc, /const temporalAnalysisQueue = new Map\(\);/,
      'F01 第二半待办：server.js 仍在用进程内 Map（S04 的 dispatcher 接线尚未落地）');
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F02 同章已排队时直接返回旧 timer → 不是 trailing debounce（→ S04）
  // ────────────────────────────────────────────────────────────────────────────
  ['F02 [静态] 同章已排队即返回旧 timer、且不 clearTimeout → 不是 trailing debounce（F02→S04）', () => {
    // 为什么只能静态：server.js 不能在不产生副作用的情况下 import（import 时会解析
    // 数据目录、打开库、注册路由并可能监听端口）。这里断的是函数文本本身，不是运行中的调度。
    const body = sliceBetween(serverSrc, 'function scheduleTemporalAnalysis(', '\n}\n');
    assert.match(body, /if \(temporalAnalysisQueue\.has\(key\)\) return temporalAnalysisQueue\.get\(key\);/,
      'F02：key 已存在时直接返回旧 timer');
    assert.ok(!body.includes('clearTimeout'),
      'F02：没有 clearTimeout —— 连续保存不会把计时器往后推，旧 timer 按原时刻触发');
    assert.ok(body.indexOf('temporalAnalysisQueue.has(key)) return') < body.indexOf('const timer = setTimeout('),
      'F02：早退发生在建新 timer 之前（这是它不等价于 debounce 的原因）');
    assert.match(body, /temporalAnalysisQueue\.set\(key, timer\);/);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F03 保存事务内调用调度器 → 事务内的定时副作用（→ S04）
  // ────────────────────────────────────────────────────────────────────────────
  ['F03 [静态] afterTemporalContentSave → scheduleTemporalAnalysis，且调用点在写事务内部（F03→S04）', () => {
    const body = sliceBetween(serverSrc, 'function afterTemporalContentSave(', '\n}\n');
    assert.match(body, /StoryState\.Temporal\.recordContentSave\(/);
    assert.match(body, /if \(result && result\.enabled && result\.recorded\) scheduleTemporalAnalysis\(w, c\);/,
      'F03：写完之后直接排分析 —— 定时副作用就发生在保存链路里');
    assert.ok(body.indexOf('recordContentSave') < body.indexOf('scheduleTemporalAnalysis(w, c)'));

    // 证明"事务内"：编辑器保存分支把调用点放在 withTx(() => { … }) 的提交之前。
    const txStart = serverSrc.indexOf('const putResult = withTx(() => {');
    const callAt = serverSrc.indexOf("afterTemporalContentSave(old.work_id, Number(id), body.content, 'editor_save');");
    assert.ok(txStart > 0 && callAt > txStart, '编辑器保存路径里确实有调用点');
    assert.ok(!/\n\s*\}\);\n/.test(serverSrc.slice(txStart, callAt)),
      'F03：调用点在 withTx 提交之前 —— 事务内起了定时器');
    const sites = (serverSrc.match(/afterTemporalContentSave\(/g) || []).length;
    assert.ok(sites >= 6, `保存写入口的调用点数量 ${sites}（应覆盖多条正文写路径）`);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F04 分析配置取"首个带 key 的配置"而不是任务指定路由（→ S10）
  // ────────────────────────────────────────────────────────────────────────────
  ['F04 [静态] temporalAnalysisConfig() 取首个带 api_key 的配置，不接受任务指定路由（F04→S10）', () => {
    const body = sliceBetween(serverSrc, 'function temporalAnalysisConfig()', '\n}\n');
    assert.match(body, /function temporalAnalysisConfig\(\)/, 'F04：函数不接收任何路由/任务参数');
    assert.match(body,
      /SELECT \* FROM api_configs WHERE api_key IS NOT NULL AND api_key <> '' ORDER BY id ASC LIMIT 1/,
      'F04：选的是 id 最小的第一条可用配置');
    assert.ok(!/WHERE[\s\S]{0,120}(route|task|requested|model_id)/i.test(body),
      'F04：查询里没有任何"任务指定的路由"条件');
    // 同一函数的调用方：生产通道把这条配置直接喂给 callAI。
    assert.match(sliceBetween(serverSrc, 'function temporalAnalysisGenerate()', '\n}\n'),
      /const config = temporalAnalysisConfig\(\);/);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F05 抽取上限：正文 12,000 / 状态 400 项 / 名称 200 个（→ S06）
  // ────────────────────────────────────────────────────────────────────────────
  ['F05 [动态] EXTRACTION_LIMITS.max_chars=12000、状态 400 项、已知名 200 个（F05→S06）', () => {
    assert.equal(T.EXTRACTION_LIMITS.max_chars, 12000);
    assert.equal(T.sanitizeText('a'.repeat(11999)).length, 11999, '边界之下不截断');
    assert.equal(T.sanitizeText('a'.repeat(12001)).length, 12000, 'F05：正文被截到 12000');
    assert.equal(T.sanitizeText('a'.repeat(50000)).length, 12000);

    const manyNames = Array.from({ length: 250 }, (_, i) => `角色${i}`);
    assert.equal(manyNames.length, 250, '前提：候选名必须真的超过 200');
    assert.equal(T.knownNamesFrom(manyNames).length, 200, 'F05：已知名被截到 200');

    // 状态项：401 个合法 cell 键，提示词里只出现 400 行。
    const stateBeforeJson = {};
    for (let i = 0; i < 401; i += 1) {
      const key = T.cellKey({ domain: 'character', entityId: `e${i}`, predicate: 'status', scope: 'canon' });
      stateBeforeJson[key] = i;
    }
    assert.equal(Object.keys(stateBeforeJson).length, 401, '前提：状态项必须真的超过 400');
    const prompt = T.buildExtractionPrompt({ plainText: '正文', stateBeforeJson });
    const stateLines = (prompt.user.match(/^character\|/gm) || []).length;
    assert.equal(stateLines, 400, `F05：状态项被截到 400，实际 ${stateLines}`);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F06 提示词示例的 scope 与 schema 白名单互相矛盾（→ S06）
  // ────────────────────────────────────────────────────────────────────────────
  ['F06 [动态] 提示词示例写 world（非法）且漏 author_plan —— 合法集从 schema.mjs 派生（F06→S06）', () => {
    const legal = [...T.SCOPES];                       // 从契约派生，不抄第二份清单
    assert.deepEqual(legal.slice().sort(), ['author_plan', 'canon', 'character', 'reader']);
    const prompt = T.buildExtractionPrompt({ plainText: '正文' });

    const example = prompt.system.match(/"scope":"([^"]*)"/);
    assert.ok(example, '提示词里应当有 scope 的 JSON 示例');
    const exampleScopes = example[1].split('|');
    assert.ok(exampleScopes.includes('world'), 'F06：示例里的 world 不在合法集合中');
    assert.ok(!legal.includes('world'), 'F06：world 确实非法');
    assert.ok(!exampleScopes.includes('author_plan'), 'F06：示例漏掉了合法的 author_plan');
    assert.notDeepEqual(exampleScopes.slice().sort(), legal.slice().sort(), 'F06：示例集合 ≠ 合法集合');

    // 同一段提示词后面又列出了正确的清单（同样由 SCOPES 派生）——
    // 等于给模型两份互相矛盾的指令，这正是 F06 的恶劣之处。
    assert.ok(prompt.system.includes(`scope 只能是：${legal.join(', ')}`),
      'F06：同一份提示词里还给出了正确清单（两份指令矛盾）');
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F07 input_hash 的第三项恒为空串 → 已知实体没有进入输入身份（→ S06）
  // ────────────────────────────────────────────────────────────────────────────
  ['F07 [动态] 已知实体变化不改变 input_hash（第三项恒空串）—— 缺陷被钉住（F07→S06）', () => {
    const stateKey = T.cellKey({ domain: 'character', entityId: '甲', predicate: 'alive', scope: 'canon' });
    const base = { plainText: '甲推开门走了进来。', stateBeforeJson: { [stateKey]: true } };
    const p1 = T.buildExtractionPrompt({ ...base, known: { characters: ['甲'] } });
    const p2 = T.buildExtractionPrompt({ ...base, known: { characters: ['完全不同的角色名'] } });

    assert.notEqual(p1.user, p2.user, '前提：已知实体确实进了 user 文本');
    assert.equal(p1.input_hash, p2.input_hash,
      'F07 缺陷：known 没有参与 input_hash（第三项 knownLine(\'\', []) 恒为空串）');

    // 对照：正文变了 input_hash 必须变 —— 说明它不是一个常量，只是漏了 known。
    const p3 = T.buildExtractionPrompt({ ...base, plainText: '另一段正文', known: { characters: ['甲'] } });
    assert.notEqual(p1.input_hash, p3.input_hash, '对照：正文进入身份');

    // 源码事实：第三项就是把空列表喂给 knownLine（永远返回空串）。
    const body = sliceBetween(readRepo('ai/story-state/temporal/extraction.mjs'), 'export function buildExtractionPrompt(', '\n}\n');
    assert.match(body, /known: knownLine\('', \[\]\)/);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F08 resultHash 只看输出前 2,000 字符（→ S06）
  // ────────────────────────────────────────────────────────────────────────────
  ['F08 [动态] 只有前 2000 字符影响 resultHash：尾部不同 → 哈希相同（F08→S06）', async () => {
    const prefix = '{"events":[]}' + 'x'.repeat(2500);
    const outA = `${prefix}TAIL-A`;
    const outB = `${prefix}TAIL-B`;
    assert.equal(outA.slice(0, 2000), outB.slice(0, 2000), '前提：两份输出的前 2000 字符逐字节相同');
    assert.notEqual(outA, outB, '前提：两份输出整体不同');
    assert.notEqual(T.sha16(outA), T.sha16(outB), '对照：整段输出的哈希其实不同');

    // 真的跑两次 analyzeChapter（注入确定性 fake generate，零计费），读回落库的 result_hash。
    const drive = async (title, output) => {
      const w = seedWork(title);
      const c = seedChapter(w, '第一章');
      T.setTemporalConfig(w, { temporal_enabled: true });
      const saved = T.recordContentSave({ workId: w, chapterId: c, contentHtml: '<p>甲推开门走了进来。</p>' });
      assert.equal(saved.recorded, true);
      const res = await T.analyzeChapter({
        workId: w, chapterId: c, force: true,
        generate: async () => ({ text: output }),
      });
      assert.equal(res.status, 'done', `分析必须真的完成：${JSON.stringify(res)}`);
      assert.equal(res.ran, true);
      const binding = T.getBinding(res.binding_id);
      const hash = binding.validation.analysis.result_hash;
      assert.equal(typeof hash, 'string');
      assert.equal(hash.length, 16, 'sha16 的读数长度');
      return hash;
    };

    const hA = await drive('F08-A', outA);
    const hB = await drive('F08-B', outB);
    assert.equal(hA, hB, 'F08 缺陷：前 2000 字符相同 → resultHash 相同（尾部差异被忽略）');

    const analysisBody = sliceBetween(readRepo('ai/story-state/temporal/analysis.mjs'), 'export async function analyzeChapter(', '\n}');
    assert.match(analysisBody, /const resultHash = sha16\(sanitizeText\(output, 2000\)\);/);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F09 兼容投影按"名字"关联，relation 用 "A|B" 字符串（→ S05）
  // ────────────────────────────────────────────────────────────────────────────
  ['F09 [动态+静态] refreshCompatProjection 按 name 关联角色/关系；改名即失联（F09→S05）', () => {
    const workId = seedWork('F09');
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(workId, '甲', '旧状态', now(), now());
    const jiaId = Number(db.prepare('SELECT id FROM characters ORDER BY id DESC LIMIT 1').get().id);
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(workId, '乙', '旧状态', now(), now());
    const yiId = Number(db.prepare('SELECT id FROM characters ORDER BY id DESC LIMIT 1').get().id);
    db.prepare('INSERT INTO character_relations (work_id, from_character_id, to_character_id, relation) VALUES (?, ?, ?, ?)')
      .run(workId, jiaId, yiId, '陌生人');

    // cell 键约定：角色用"模型给的名字"当 entityId，关系用 "A|B" 字符串。
    const charKey = T.cellKey({ domain: 'character', entityId: '甲', predicate: 'status', scope: 'canon' });
    const stableKey = T.cellKey({ domain: 'character', entityId: '甲的稳定ID', predicate: 'status', scope: 'canon' });
    const relKey = T.cellKey({ domain: 'relation', entityId: '甲|乙', predicate: '师徒', scope: 'canon' });
    assert.equal(T.parseCellKey(charKey).entityId, '甲');
    assert.equal(T.parseCellKey(relKey).entityId, '甲|乙', 'F09：关系实体 id 是 "A|B" 拼接串');

    const state = T.stateFromJson(JSON.stringify({
      [charKey]: '新状态',
      [stableKey]: '不该被写进任何角色行',
      [relKey]: { from: '甲', to: '乙', label: '师徒' },
    }));

    const first = T.refreshCompatProjection({ workId, state, commitId: 'cmt_f09_a' });
    assert.equal(first.ok, true);
    assert.equal(first.characters_updated, 1, 'F09：只有 name 命中的那一行被更新');
    assert.equal(first.relations_updated, 1);
    assert.equal(db.prepare('SELECT status FROM characters WHERE id = ?').get(jiaId).status, '新状态');
    assert.equal(db.prepare('SELECT status FROM characters WHERE id = ?').get(yiId).status, '旧状态');
    assert.equal(db.prepare('SELECT relation FROM character_relations WHERE id = (SELECT id FROM character_relations WHERE work_id = ?)').get(workId).relation, '师徒');

    // 改名即失联：同一份状态再投影一次，更新数变 0（这就是"按名关联"的脆弱面）。
    db.prepare('UPDATE characters SET name = ? WHERE id = ?').run('甲改名', jiaId);
    const second = T.refreshCompatProjection({ workId, state, commitId: 'cmt_f09_b' });
    assert.equal(second.characters_updated, 0, 'F09：角色改名后按名关联直接失效');
    assert.equal(db.prepare('SELECT status FROM characters WHERE id = ?').get(jiaId).status, '新状态', '没命中就不会被改写');

    const compatSrc = readRepo('ai/story-state/temporal/compat.mjs');
    assert.match(compatSrc, /UPDATE characters SET status = \?, updated_at = \? WHERE work_id = \? AND name = \? AND status <> \?/);
    assert.match(compatSrc, /JOIN characters a ON a\.id = r\.from_character_id[\s\S]{0,120}WHERE r\.work_id = \? AND a\.name = \? AND b\.name = \?/);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F10 就绪检测只看两个生成文件（→ S14）
  // ────────────────────────────────────────────────────────────────────────────
  ['F10 [静态] isHarnessBuilt() 只看两个 typert.host.js 生成文件（F10→S14）', () => {
    // 为什么静态：harness.js 在模块顶层调用 restoreHarnessSettingsIfNeeded()（会碰作者的真实
    // DSH 设置），不能为了断言而 import 它。这里断的是函数文本，不是运行结果。
    const body = sliceBetween(readRepo('harness.js'), 'export function isHarnessBuilt()', '\n}\n');
    const markers = [...body.matchAll(/path\.join\(dir, '([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(markers, [
      'packages/interaction/commands/lib/typert.host.js',
      'packages/goal/goal/lib/typert.host.js',
    ], 'F10：就绪判据只有这两个文件');
    assert.equal((body.match(/typert\.host\.js/g) || []).length, 2);
    assert.match(body, /return markers\.every\(\(file\) => fs\.existsSync\(file\)\);/,
      'F10：两个文件都存在就算"已构建"');
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F11 通用文件工具来自 bundle / preset，不在插件自己的工具清单里（→ S09）
  // ────────────────────────────────────────────────────────────────────────────
  ['F11 [静态] 插件只注册 26 个 novel_*；通用 fs 工具来自 bundle 补丁与 GUI preset（F11→S09）', () => {
    const generic = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh'];

    // ① 插件自己的工具清单（plugin.json）与真实注册点（novel-tools.mjs）都只有 novel_*。
    const pluginTools = JSON.parse(readRepo('harness-plugins/novel-writing/plugin.json')).tools.map((t) => String(t.name));
    assert.equal(pluginTools.length, 26, `插件声明 ${pluginTools.length} 个工具（应为 26 个 novel_*）`);
    assert.deepEqual(pluginTools.filter((n) => !n.startsWith('novel_')), [], '插件不得注册非 novel_* 工具');
    assert.deepEqual(pluginTools.filter((n) => generic.includes(n)), [], 'F11：插件的工具清单里没有通用文件工具');
    const registered = [...readRepo('harness-plugins/novel-writing/novel-tools.mjs').matchAll(/register\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.equal(registered.length, 26, `novel-tools.mjs 实际注册 ${registered.length} 个工具`);
    assert.deepEqual(registered.filter((n) => !n.startsWith('novel_')), []);
    assert.deepEqual(registered.filter((n) => generic.includes(n)), []);

    // ② bundle 补丁层保留通用 read/write/edit/glob/grep，且不把它们禁掉。
    const patch = readRepo('harness-plugins/novel-writing/cordis.patch.yml');
    assert.match(patch, /保留：novel_\* 工具 \+ read\/write\/edit\/glob\/grep/,
      'F11：bundle 补丁明说保留通用文件工具');
    const disabledIds = [...patch.matchAll(/id:\s*([a-z0-9-]+),\s*disabled:\s*true/g)].map((m) => m[1]);
    assert.ok(disabledIds.length >= 15, `补丁至少禁用 15 条能力，实际 ${disabledIds.length}`);
    for (const name of ['tool-read', 'tool-write', 'tool-edit', 'tool-glob', 'tool-grep', 'read', 'write', 'edit', 'glob', 'grep']) {
      assert.ok(!disabledIds.includes(name), `F11：补丁没有禁用 ${name}（通用文件工具被保留）`);
    }

    // ③ GUI preset 层另外加了 tool-fs + tool-fs-search。
    const preset = readRepo('harness-plugins/novel-writing/agent.cordis.yml');
    assert.match(preset, /- id: tool-fs\b/);
    assert.match(preset, /- id: tool-fs-search\b/);
    assert.match(preset, /name: '@deepseek-ai\/dsh-tool-fs'/);
    assert.match(preset, /name: '@deepseek-ai\/dsh-tool-fs-search'/);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // F12 入口巨型文件：server.js 手写 if 链路由 / app.js 无构建单作用域（→ S03）
  // （baseline.md §3 F12 的措辞是"单条 if 链 handleAPI()"；实测归属已订正，见用例内注释）
  // ────────────────────────────────────────────────────────────────────────────
  ['F12 [静态度量] server.js 手写 if 链路由（4 个 handler 函数）；public/app.js 无模块边界、无构建步骤（F12→S03）', () => {
    const serverBytes = fs.statSync(path.join(REPO, 'server.js')).size;
    const serverLines = serverSrc.split('\n').length;
    assert.ok(serverBytes > 500 * 1024, `server.js ${serverBytes} 字节（实测 >500KB）`);
    assert.ok(serverLines > 9000, `server.js ${serverLines} 行（实测 >9000）`);
    assert.ok(serverSrc.includes('async function handleAPI(req, res, pathname, query) {'));

    // 路由分派按 `resource`（segments[1]）串成手写 if 链，**不是**按 pathname 字面量匹配：
    // 实测 `if (pathname ===` 只有 1 处（静态根），`router.` / `const routes =` 都是 0 次。
    const resourceBranches = (serverSrc.match(/if \(resource === /g) || []).length;
    const pathnameBranches = (serverSrc.match(/if \(pathname ===/g) || []).length;
    const resourceNames = new Set([...serverSrc.matchAll(/if \(resource === '[a-z_]+'/g)].map((m) => m[0]));
    assert.equal((serverSrc.match(/\brouter\./g) || []).length, 0, 'F12：没有路由表/框架，全是手写分支');
    assert.equal((serverSrc.match(/const routes\s*=/g) || []).length, 0);
    assert.ok(resourceBranches >= 80, `if (resource === …) 出现 ${resourceBranches} 次（实测 117）`);
    assert.ok(resourceNames.size >= 20, `资源分支 ${resourceNames.size} 个（实测 25）`);
    assert.equal(pathnameBranches, 1, `if (pathname ===) 只有静态根那一处，实测 ${pathnameBranches}`);

    // 归属订正（baseline.md §3 F12 写的是"单条 if 链 handleAPI()"）：实测 handleAPI 只占
    // 117 条 resource 分支里的 15 条，其余落在同一文件里另外 3 个手写 handler 函数中。
    // 这里把这个真实归属钉住，避免下游拿"都在 handleAPI 里"的错误前提去做拆分。
    const handlerFns = [...serverSrc.matchAll(/^(?:async )?function (handle[A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]);
    assert.ok(handlerFns.includes('handleAPI'), `顶层 handler 函数清单里必须有 handleAPI：${handlerFns.join(', ')}`);
    assert.ok(handlerFns.length >= 4, `顶层路由 handler ${handlerFns.length} 个（实测 4：${handlerFns.join(', ')}）`);
    const handleAt = serverSrc.indexOf('async function handleAPI(');
    const handleEnd = serverSrc.indexOf('\n}\n', handleAt);
    assert.ok(handleEnd > handleAt, 'handleAPI 的结束位置可定位');
    const handleRegion = serverSrc.slice(handleAt, handleEnd);
    const branchInHandleAPI = (handleRegion.match(/if \(resource === /g) || []).length;
    assert.ok(handleRegion.length > 20000, `handleAPI 单函数 ${handleRegion.length} 字符（实测 42773）`);
    assert.ok(branchInHandleAPI >= 10, `handleAPI 内 ${branchInHandleAPI} 条 resource 分支（实测 15）`);
    assert.ok(resourceBranches > branchInHandleAPI, 'F12 订正：路由分支不止在 handleAPI 里');

    const appSrc = readRepo('public/app.js');
    const appBytes = fs.statSync(path.join(REPO, 'public/app.js')).size;
    const appLines = appSrc.split('\n').length;
    assert.ok(appBytes > 900 * 1024, `public/app.js ${appBytes} 字节（实测 >900KB）`);
    assert.ok(appLines > 15000, `public/app.js ${appLines} 行（实测 18223）`);
    assert.equal((appSrc.match(/^(import|export)\s/gm) || []).length, 0,
      'F12：一个扁平全局作用域（没有任何 ESM 模块边界）');
    const pkg = JSON.parse(readRepo('package.json'));
    assert.ok(!('build' in (pkg.scripts || {})), 'F12：前端没有构建步骤（package.json 里没有 build）');
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // D1 HEAD 读-比-写不是 CAS；null parent 时整段校验被跳过（→ S03）
  // ────────────────────────────────────────────────────────────────────────────
  ['D1 [静态+动态] HEAD 推进必须是行级 CAS，且期望值取自本次读到的 HEAD（S03 已修）', () => {
    const wlSrc = readRepo('ai/story-state/temporal/worldline-store.mjs');
    // (a) 推进 HEAD 的唯一入口是 advanceHeadCas，它的 UPDATE 把**读到的旧 HEAD 值**带进 WHERE。
    assert.match(wlSrc, /function advanceHeadCas\(\{ worldlineId, expectedHead, newHead \}\)/,
      'D1 已修：CAS 必须由唯一入口承担');
    assert.match(wlSrc, /WHERE id = \? AND head_commit_id IS \?/,
      'D1 已修：推进 HEAD 的 UPDATE 必须带 CAS 守卫（WHERE head_commit_id IS ?）');
    assert.match(wlSrc, /advanceHeadCas\(\{ worldlineId: wl\.id, expectedHead: expectedHead !== null \? expectedHead : head, newHead: id \}\)/,
      'D1：期望值必须来自本次读到的 head（调用方给 null 时也一样）');
    assert.equal((wlSrc.match(/advanceHeadCas\(/g) || []).length, 2,
      'D1：只有一个调用点（定义 + 调用），不得再有旁路的无条件 UPDATE');
    // ⚠️ genesis（`ensureMainCommit`）仍保留一条直写：那是"从无到有"建立 HEAD 的一步，
    //    此时不存在可比较的旧值。S03 保证的是**提交推进**这一步必须 CAS。
    //    （注意这里用字符串字面量 `').run` 作定界——源文件用的是单引号模板，不是反引号；
    //      第一版按反引号写，正则恒为 0 命中，等于把这条断言变成了恒真。）
    const directWrites = (wlSrc.match(/UPDATE story_worldlines SET head_commit_id = \? WHERE id = \?'\)\.run/g) || []).length;
    assert.equal(directWrites, 1, `D1：除 genesis 外不得再有直写 HEAD 的语句（实际 ${directWrites} 处）`);

    // (b) 服务层仍传 parentCommitId 作默认值；**这不再开窗口**——期望值由读到的 head 兜底。
    const svcSrc = readRepo('ai/story-state/temporal/service.mjs');
    assert.match(svcSrc, /expectedHead: expectedHead === null \? parentCommitId : expectedHead/,
      'D1：服务层默认值保持原样（由内核的 CAS 兜底，而不是靠调用方记得传）');

    // (c) 判据本身在 SQL 层真的会命中 0 行（不是"写了但恒真"）——用隔离的临时表模拟同一条语句。
    db.exec('CREATE TABLE IF NOT EXISTS _d1_cas_probe (id INTEGER PRIMARY KEY, head_commit_id TEXT)');
    const probe = db.prepare('UPDATE _d1_cas_probe SET head_commit_id = ? WHERE id = ? AND head_commit_id IS ?');
    db.prepare('INSERT INTO _d1_cas_probe (id, head_commit_id) VALUES (1, ?)').run('H1');
    assert.equal(probe.run('H2', 1, 'H1').changes, 1, 'CAS：期望值命中 → 允许推进');
    db.prepare('UPDATE _d1_cas_probe SET head_commit_id = ? WHERE id = 1').run('H3');
    assert.equal(probe.run('H4', 1, 'H1').changes, 0,
      'CAS：期望值已被别处改掉 → 命中 0 行（这就是"静默覆盖"被挡住的机制）');
    assert.equal(probe.run('H4', 1, null).changes, 0, 'CAS：期望空而实际非空 → 同样命中 0 行');
    db.prepare('DELETE FROM _d1_cas_probe');

    // (d) 动态：首次提交（HEAD 为空）正常推进 —— 窗口不是恒关。
    const workId = seedWork('D1');
    const wl = T.ensureMainWorldline(workId);
    assert.equal(wl.head_commit_id, null, '前置：世界线 HEAD 为空');
    const c1 = T.commitManifest({ workId, worldlineId: wl.id, parentCommitId: null, chapters: {}, note: 'd1-first' });
    assert.equal(T.getWorldline(wl.id).head_commit_id, c1.commit.id, '首次提交必须能推进');

    // 显式给过时的 expectedHead → 冲突（这条修改前就成立，留作对照）。
    assert.throws(
      () => T.commitManifest({ workId, worldlineId: wl.id, parentCommitId: c1.commit.id, chapters: {}, note: 'd1-stale', expectedHead: 'cmt_nonexistent' }),
      (e) => e && e.code === 'HEAD_CAS_MISMATCH',
    );
    assert.equal(T.getWorldline(wl.id).head_commit_id, c1.commit.id, '冲突时 HEAD 不得被推进');

    // 顺序推进照常可用（CAS 没有把合法路径一并挡掉）。
    const c2 = T.commitManifest({ workId, worldlineId: wl.id, parentCommitId: c1.commit.id, chapters: {}, note: 'd1-second-ok' });
    assert.equal(T.getWorldline(wl.id).head_commit_id, c2.commit.id, '顺序推进必须照常成功');

    // ★ 诚实声明：**没有**做到"两个写者交错下的实测"。两种做法都试过、都已被实测排除：
    //   ① 直接调 commitManifest —— 它是同步函数，读与写之间没有 await 点，测试无法插入交错；
    //   ② 挂 SQLite BEFORE UPDATE 触发器制造交错 —— 实测无效：外层语句会用 NEW 值覆盖触发器的子更新
    //      （探针实测 head 最终是新值，而不是触发器写的 'RACER'），所以触发器模拟不了"别人先写了"。
    // 结论：D1 的**并发复现**仍是遗留项（已记入 known-issues.json 的 verificationGap，留给 S15 故障矩阵）。
    // 本用例只钉住"行级 CAS 无旁路"与"该判据在 SQL 层真的会命中 0 行"这两件可测的事。
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // D2 校验失败必须整体回滚，不得留下孤儿事件行（**S03 已修**）
  // ────────────────────────────────────────────────────────────────────────────
  ['D2 [动态] validateEventSet 失败 → 事务回滚、零孤儿事件行，但对外契约不变（S03 已修）', () => {
    const { workId, chapterId } = seedTemporalChapter('D2', '甲站在原地。');
    const rev = T.latestRevisionOf(chapterId);
    assert.ok(rev, '前置：必须有正文修订');
    const headBefore = T.getWorldline(T.ensureMainWorldline(workId).id).head_commit_id;

    // expected 给一个章前并不存在的值 → 前置条件必然失败（conflict）。
    const res = T.applyChapterEvents({
      workId, chapterId,
      events: [{
        cursor: { chapter_index: 0 },
        ops: [{
          type: 'set',
          cell: { domain: 'character', entityId: '甲', predicate: 'alive', scope: 'canon' },
          expected: { kind: 'value', value: false },
          value: true,
        }],
        evidence: [{ quote: '甲站在原地。', narrative: 'present' }],
      }],
    });
    // ① 对外契约**不变**：仍然是"返回一个带结论的对象"，不是抛异常
    //    （既有套件 tests/temporal/03-integrity 有四处断言依赖这个形状，S03 不得改动它们）。
    assert.equal(res.ok, false, `D2 已修：仍须返回结论对象：${JSON.stringify(res)}`);
    assert.equal(res.decision, 'conflict', `期望硬冲突，实际 ${res.decision}`);

    // ② S03 之后：**没有**任何事件行落库 —— 被拒绝的确认整体回滚。
    const rowCount = Number(db.prepare('SELECT COUNT(*) AS c FROM story_state_events WHERE chapter_id = ?').get(chapterId).c);
    assert.equal(rowCount, 0, `D2 已修：被拒绝的确认不得留下任何事件行（实际 ${rowCount} 行）`);
    const bound = Number(db.prepare("SELECT COUNT(*) AS c FROM story_chapter_bindings WHERE chapter_id = ? AND validity = 'valid'").get(chapterId).c);
    assert.equal(bound, 0, 'D2：没有 valid 绑定');
    assert.equal(T.getWorldline(T.ensureMainWorldline(workId).id).head_commit_id, headBefore, 'D2：HEAD 不得被推进');
    // 回执仍然带回它**本会**写入的事件 id（供界面解释"哪些操作没生效"），但这些 id 在库里不存在。
    assert.ok(Array.isArray(res.event_ids), '回执保留 event_ids 字段（契约不变）');
    if (res.event_ids.length) {
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM story_state_events WHERE id = ?').get(res.event_ids[0]).c), 0,
        'D2 已修：回执里的事件 id 在库里**不存在**（证明已回滚）');
    }
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // D3 HEAD_CAS_MISMATCH 的 HTTP 处理点（**S03 已修**：由"零匹配"改为"必须有 409 映射"）
  // ────────────────────────────────────────────────────────────────────────────
  ['D3 [静态] server.js 必须有 HEAD_CAS_MISMATCH → 409 的处理点（S03 已修，此断言防止回退）', () => {
    const hits = (serverSrc.match(/HEAD_CAS_MISMATCH/g) || []).length;
    assert.ok(hits >= 1, `D3 已修：server.js 必须出现该错误码并映射成 409，实际 ${hits} 处`);
    // 必须是 **409** 而不是通用 500：那条映射把内核的 current_head 一起带给调用方。
    assert.match(serverSrc, /sendError\(res,\s*409,[\s\S]{0,400}HEAD_CAS_MISMATCH/,
      'D3：必须存在把 HEAD_CAS_MISMATCH 映射成 409 的分支');
    assert.match(serverSrc, /sendTemporalConflictOrThrow/, 'D3：映射由专用辅助函数承担（两个确认入口共用）');
    // 反证：错误码在内核里仍然由世界线层抛出（说明映射的对象真实存在）。
    assert.match(readRepo('ai/story-state/temporal/worldline-store.mjs'), /HEAD_CAS_MISMATCH/);
    assert.ok((serverSrc.match(/sendError\(res, 500/g) || []).length >= 1, '通用 500 出口仍然存在（其它错误照旧）');
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // D4 迁移逐条执行、不包事务、无 user_version / 迁移账本（→ S03）
  // ────────────────────────────────────────────────────────────────────────────
  ['D4 [静态+schema] MIGRATIONS 逐条 exec 且不包事务；user_version=0、无迁移账本表（D4→S03）', () => {
    const dbSrc = readRepo('db.js');
    assert.match(dbSrc, /const MIGRATIONS = \[/);
    const loop = sliceBetween(dbSrc, 'for (const sql of MIGRATIONS) {', '\n}\n');
    assert.match(loop, /db\.exec\(sql\);/);
    assert.ok(!/withTransaction|SAVEPOINT|'BEGIN'|COMMIT/.test(loop),
      'D4：逐条执行且没有事务包裹（中途失败会留下部分应用的 schema）');
    assert.match(loop, /\/duplicate column\/i/, 'D4：只吞"列已存在"，其余仅告警');
    assert.ok(!/user_version/.test(dbSrc), 'D4：没有 user_version');
    assert.ok(!/CREATE TABLE IF NOT EXISTS [a-z_]*(migrat|ledger)/i.test(dbSrc), 'D4：没有迁移账本表');

    // schema：查真实临时库。
    const uv = db.prepare('PRAGMA user_version').get();
    assert.equal(Number(uv.user_version), 0, 'D4：新库的 user_version 是 0（从未写入版本）');
    const tables = tableNames();
    assert.ok(!tables.some((t) => /migrat/i.test(t)), `D4：不应有迁移账本表，实际 ${tables.filter((t) => /migrat/i.test(t)).join(', ')}`);
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // D5 confirmBinding 的"重放复用"必须先过输入复核（**S03 已修**）
  // ────────────────────────────────────────────────────────────────────────────
  ['D5 [动态] 已是 valid 的绑定在正文被改写后必须回 stale，不得再发复用回执（S03 已修）', () => {
    const text = '甲推开门走了进来。';
    const { workId, chapterId } = seedTemporalChapter('D5', text);
    const r1 = T.latestRevisionOf(chapterId);

    const applied = T.applyChapterEvents({ workId, chapterId, events: [validEvent(text)] });
    assert.equal(applied.ok, true, `前置：必须真的确认出一份 valid 绑定：${JSON.stringify(applied)}`);
    const validBinding = T.getBinding(applied.binding_id);
    assert.equal(validBinding.validity, 'valid');

    // ④ 关键阴性对照（S03 起必须成立）：**中间没有再保存**时，重放仍须回 reused:true。
    //    这条保证"D5 的修法"没有把幂等性一起改掉（上面若干既有套件依赖这个回执）。
    const immediateReplay = T.confirmBinding({ workId, chapterId, bindingId: validBinding.id });
    assert.equal(immediateReplay.ok, true, `无新保存的重放必须仍然复用：${JSON.stringify(immediateReplay)}`);
    assert.equal(immediateReplay.reused, true);

    // 之后又保存了一版**不同正文** → 该绑定引用的修订已经过期（正文哈希不同）。
    T.recordContentSave({ workId, chapterId, contentHtml: '<p>乙走过来，甲已经不在了。</p>' });
    const latest = T.latestRevisionOf(chapterId);
    assert.notEqual(latest.id, r1.id, '前置：确实有了更新的修订');
    assert.notEqual(String(latest.text_hash), String(r1.text_hash), '前置：文本哈希确实变了');

    // ① 同一个"已过期"条件下，pending 绑定会走完整的陈旧复核 → stale（说明判据存在、可达）。
    const control = T.createBinding({
      workId, chapterId, revisionId: r1.id, eventIds: validBinding.event_ids || [], validity: 'pending',
      validation: { kind: 'probe', note: 'D5 对照组：伪造一条 pending 绑定，指向过期修订' },
    });
    const controlVerdict = T.confirmBinding({ workId, chapterId, bindingId: control.id });
    assert.equal(controlVerdict.ok, false, `对照：pending 绑定必须被陈旧复核拦下：${JSON.stringify(controlVerdict)}`);
    assert.equal(controlVerdict.decision, 'stale');

    // ② S03 之后：valid 绑定在正文被改写后**不再**发复用回执，而是如实回 stale。
    const replay = T.confirmBinding({ workId, chapterId, bindingId: validBinding.id });
    assert.equal(replay.ok, false, `D5 已修：valid 绑定不得在正文已改写时复用：${JSON.stringify(replay)}`);
    assert.equal(replay.decision, 'stale');

    // 静态：陈旧复核（latest）现在必须排在复用早退**之前**。
    const svcSrc = readRepo('ai/story-state/temporal/service.mjs');
    const confirmBody = sliceBetween(svcSrc, 'export function confirmBinding(', '\n}\n');
    const replayAt = confirmBody.indexOf("if (binding.validity === 'valid')");
    const latestAt = confirmBody.indexOf('const latest = latestRevisionOf(c);');
    assert.ok(replayAt > 0 && latestAt > 0 && latestAt < replayAt,
      'D5 已修：陈旧复核必须排在 valid 复用早退之前');
  }],

  // ────────────────────────────────────────────────────────────────────────────
  // D6 契约声明 NOVELSTUDIO_HARNESS_POOL，但没有任何代码读它（→ S09）
  // ────────────────────────────────────────────────────────────────────────────
  ['D6 [静态] host-contract 声明 NOVELSTUDIO_HARNESS_POOL；生产代码零读取者（D6→S09）', () => {
    // ① 声明存在（并且是契约 JSON 里的正经键，不是注释）。
    const contractRaw = readRepo('docs/host-contract.v1.json');
    assert.ok(contractRaw.includes('NOVELSTUDIO_HARNESS_POOL'), 'D6：契约里确实声明了它');
    assert.ok(JSON.stringify(JSON.parse(contractRaw)).includes('NOVELSTUDIO_HARNESS_POOL'));

    // ② 语料：仓库内的生产代码（跳过 tests/ 与点开头的基线/侦察目录）。
    const codeFiles = PRODUCTION_CODE_FILES;
    assert.ok(codeFiles.length > 100, `语料应当覆盖生产代码，实际 ${codeFiles.length} 个文件`);
    const mentions = codeFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('NOVELSTUDIO_HARNESS_POOL')).map(relOf);
    assert.deepEqual(mentions, ['ai/harness-pool.mjs'],
      'D6：唯一提到它的生产文件是热备池自己（且只是"这个开关不存在"的注释）');
    const poolSrc = readRepo('ai/harness-pool.mjs');
    assert.ok(!/process\.env\.NOVELSTUDIO_HARNESS_POOL/.test(poolSrc), 'D6：运行时代码从不读这个环境变量');
    assert.ok(poolSrc.includes('NOVELSTUDIO_HARNESS_POOL=1'), 'D6：头注释自陈该开关"写了也不生效"');

    // ③ 连热备池本身也没有生产 importer：唯一引用它的 harness-sdk-worker 同样没人 import。
    const importers = codeFiles.filter((f) => /from\s+'\.\/harness-pool\.mjs'/.test(fs.readFileSync(f, 'utf8'))).map(relOf);
    assert.deepEqual(importers, ['ai/harness-sdk-worker.mjs']);
    const workerUsers = codeFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('harness-sdk-worker')).map(relOf);
    assert.deepEqual(workerUsers, ['ai/harness-sdk-worker.mjs'], 'D6：没人 import harness-sdk-worker → 热备池链路无生产接线');
  }],
]);

// ── 收尾：关库 + 删临时目录（删不干净必须报出来，不静默留垃圾）────────────────────
try { db.close(); } catch (_) { /* 已经关了 */ }
assert.equal(env.cleanup(), true, `临时目录未删干净：${env.root}`);
