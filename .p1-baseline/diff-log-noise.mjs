#!/usr/bin/env node
/**
 * diff-log-noise.mjs —— 只读诊断：app_logs 的「真实库 vs 副本」差集该怎么判？
 *
 * 它回答的是**两个方向不同**的问题：
 *   ① 副本里有、真实库没有的行 —— 是**副本自身的噪声**（隔离不彻底的探针写的），
 *      还是真实库真的删过行？
 *   ② 真实库里有、副本没有的行 —— 是**副本采样之后的正常增长**（应用运行时就在写日志），
 *      还是「真实库被别的进程写过 / 被改写」？
 *
 * ⚠️ 2026-09-22 校正（旧判据错在哪）：旧实现把 ② 一律判成「真实库被删除的行」并要求为 0。
 *    可副本是**某一次采样**的快照，而真实库是活的——应用只要继续跑，②就必然 >0。
 *    于是这条检查在正常使用下**恒为红**（实测：副本停在早先采样，真实库多出 113 行正常日志，
 *    一键验收因此长期挂着一条假警）。现在用 **id 顺序**把 ② 拆成两桶（id 是自增主键，
 *    副本是真实库某次采样的前缀拷贝）：
 *      · id > 副本最大 id → 采样之后的新增，**正常增长，不判红**；
 *      · id ≤ 副本最大 id → 副本本该包含却缺失 → **真信号**（分叉 / 回滚 / 被改写），判红。
 *    另外：②的新增行里若带**探针/验证脚本特征**（verify- / probe- / .p1-baseline/ …）也判红——
 *    那正是 2026-09-15 事故的形态（测试脚本指向了真实数据目录）。实测该特征在真实库
 *    309 行日志里命中 0 行，所以它的假阳性风险已被数据本身排除。
 *
 * 只读：两个库均以 readonly 打开；不写任何文件（除 stdout 与 --self-test 的临时库）。
 * 陷阱：不要 import 本项目的业务模块（db.js / logger.js 会在模块顶层打开真实库）。
 *
 * 用法:
 *   node .p1-baseline/diff-log-noise.mjs               # 真实库 vs 默认副本 .p1-baseline/data/novel.db
 *   node .p1-baseline/diff-log-noise.mjs <副本路径>
 *   node .p1-baseline/diff-log-noise.mjs --self-test   # 判据自检（三条用例，不需要真实库）
 *
 * 退出码：0 = 没有真信号（差集可由「正常增长 / 副本噪声」解释）；1 = 出现真信号，需人工看；
 *         2 = 缺少数据库（跑不了，与「未通过」分开）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** 探针/验证脚本特征：2026-09-15 那类写入会在 message 里留下这些字样。 */
export const PROBE_SIGNATURE = /(verify-|probe-|diff-real-db|compare-baseline|capture-baseline|harness-gate|make-stress|\.p1-baseline|\.p0-recon)/i;

/**
 * 集合差 + **归因分类**（纯函数，供审计与自检共用）。
 *
 * @param {Array<{id:number,ts?:string,layer?:string,level?:string,kind?:string,message?:string}>} realRows
 * @param {Array<{id:number}>} copyRows
 */
export function classifyLogDiff(realRows, copyRows) {
  const rIds = new Set(realRows.map((x) => x.id));
  const cIds = new Set(copyRows.map((x) => x.id));
  const onlyReal = realRows.filter((x) => !cIds.has(x.id));
  const onlyCopy = copyRows.filter((x) => !rIds.has(x.id));
  const copyMaxId = copyRows.length ? Math.max(...copyRows.map((x) => x.id)) : 0;
  const realMaxId = realRows.length ? Math.max(...realRows.map((x) => x.id)) : 0;
  return {
    onlyReal,
    onlyCopy,
    copyMaxId,
    realMaxId,
    /** 采样之后的新增（副本看不到它们，属正常）。 */
    onlyRealNewer: onlyReal.filter((x) => x.id > copyMaxId),
    /** 副本 id 范围内却缺失 —— 两库不再互为前缀，属真信号。 */
    onlyRealInside: onlyReal.filter((x) => x.id <= copyMaxId),
  };
}

/** 判据：把差集翻译成「要不要人工看」。 */
export function judgeLogDiff(diff) {
  const suspiciousNewer = (diff.onlyRealNewer || [])
    .filter((x) => PROBE_SIGNATURE.test(String(x.message || '')));
  return {
    suspiciousNewer,
    alarm: (diff.onlyRealInside || []).length > 0 || suspiciousNewer.length > 0,
  };
}

function openRO(p) {
  return new DatabaseSync(p, { readOnly: true });
}

function rows(db) {
  // id 是自增主键，足以做集合差；ts 用于时间范围描述。
  return db.prepare('SELECT id, ts, layer, level, kind, message FROM app_logs ORDER BY id').all();
}

function span(list) {
  if (!list.length) return '（无）';
  return `${list[0].ts} … ${list[list.length - 1].ts}`;
}

function main() {
  const REAL = path.join(REPO, 'data', 'novel.db');
  const COPY = process.argv[2] || path.join(HERE, 'data', 'novel.db');

  for (const p of [REAL, COPY]) {
    if (!existsSync(p)) {
      console.error(`缺少数据库：${p}`);
      process.exit(2);
    }
  }

  const real = openRO(REAL);
  const copy = openRO(COPY);
  const r = rows(real);
  const c = rows(copy);
  const diff = classifyLogDiff(r, c);
  const judge = judgeLogDiff(diff);
  const { onlyReal, onlyCopy, onlyRealNewer, onlyRealInside, copyMaxId, realMaxId } = diff;

  console.log('═══ app_logs 集合差（按 id） ═══');
  console.log(`  真实库 ${r.length} 行 / 副本 ${c.length} 行`);
  console.log(`  仅真实库有（真实库有、副本没有）: ${onlyReal.length}`
    + `（其中 id > 副本最大 id #${copyMaxId} 的新增 ${onlyRealNewer.length}；范围内缺失 ${onlyRealInside.length}）`);
  console.log(`  仅副本有  （副本噪声 / 真实库缺行）: ${onlyCopy.length}`);
  console.log(`  真实库时间范围: ${span(r)}`);
  console.log(`  副本时间范围  : ${span(c)}`);

  if (onlyRealInside.length) {
    console.log('\n═══ ✗ 真信号：副本 id 范围内缺失的行（两库已不是「前缀」关系） ═══');
    for (const x of onlyRealInside.slice(0, 50)) {
      console.log(`  #${x.id} ${x.ts} [${x.layer}/${x.level}/${x.kind}] ${String(x.message || '').slice(0, 160)}`);
    }
    if (onlyRealInside.length > 50) console.log(`  … 其余 ${onlyRealInside.length - 50} 行略`);
  }

  if (onlyRealNewer.length) {
    console.log(`\n═══ 采样之后的新增（${onlyRealNewer.length} 行，#${onlyRealNewer[0].id} … #${realMaxId}）═══`);
    console.log('  正常情况 = 应用运行时自己写的日志（副本在采样时刻看不到它们，不算异常）。');
    for (const x of onlyRealNewer.slice(0, 10)) {
      console.log(`  #${x.id} ${x.ts} [${x.layer}/${x.kind}] ${String(x.message || '').slice(0, 120)}`);
    }
    if (onlyRealNewer.length > 10) console.log(`  … 其余 ${onlyRealNewer.length - 10} 行略`);
    if (judge.suspiciousNewer.length) {
      console.log(`\n  ✗ 其中 ${judge.suspiciousNewer.length} 行带「探针/验证脚本」特征 —— 这类写入不该出现在真实库：`);
      for (const x of judge.suspiciousNewer.slice(0, 20)) {
        console.log(`    #${x.id} ${x.ts} ${String(x.message || '').slice(0, 160)}`);
      }
    } else {
      console.log('  ✓ 这些新增行没有一条带「探针/验证脚本」特征。');
    }
  }

  if (onlyCopy.length) {
    console.log('\n═══ 仅副本有的行（噪声来源，用于归因） ═══');
    for (const x of onlyCopy.slice(0, 50)) {
      console.log(`  #${x.id} ${x.ts} [${x.layer}/${x.level}/${x.kind}] ${String(x.message || '').slice(0, 160)}`);
    }
    const idMin = Math.min(...onlyCopy.map((x) => x.id));
    const idMax = Math.max(...onlyCopy.map((x) => x.id));
    console.log(`\n  噪声 id 区间: ${idMin} … ${idMax}`);
    console.log(`  真实库最大 id: ${realMaxId}`);
    if (idMin > realMaxId) {
      console.log('  → 噪声全部大于真实库最大 id：副本在被采样的时刻「后来居上」，是副本自己写入的。');
    } else {
      console.log('  → 噪声与真实库 id 区间重叠：可能两库曾来自同一祖先后被分叉，也可能是真实库删过行'
        + '（应用有「清空日志」功能，删行属预期操作）——看 message 特征再判。');
    }
    const hits = onlyCopy.filter((x) => PROBE_SIGNATURE.test(String(x.message || '')));
    console.log(`\n  命中「探针/验证脚本」特征的行: ${hits.length} / ${onlyCopy.length}`);
    for (const x of hits.slice(0, 20)) {
      console.log(`    #${x.id} ${String(x.message || '').slice(0, 160)}`);
    }
  }

  console.log('\n═══ 结论 ═══');
  if (!judge.alarm) {
    console.log('  ✓ 没有真信号：真实库里的差集可由「副本采样之后的正常增长」解释，');
    console.log('    副本里的差集是副本自身的噪声（或真实库清空日志的预期删除）。');
    if (onlyRealNewer.length) {
      console.log(`  · 想让两库严格可比（差集清零）就重新采样副本：把 data/novel.db 复制到 ${path.relative(REPO, COPY)}。`);
    }
  } else {
    console.log('  ✗ 出现真信号，需要人工看：');
    if (onlyRealInside.length) console.log(`    · ${onlyRealInside.length} 行落在副本 id 范围内却在副本里找不到（两库已分叉）。`);
    if (judge.suspiciousNewer.length) console.log(`    · ${judge.suspiciousNewer.length} 行新增带「探针/验证脚本」特征（测试脚本写进了真实库？）。`);
  }
  process.exit(judge.alarm ? 1 : 0);
}

/**
 * 判据自检（含阴性对照）：判错的两个方向都危险——报假警会让人去查不存在的问题，
 * 漏报会让「真实库被删改过」悄悄通过。这里用三个小夹具把两个方向都钉住。
 */
export function selfTestLogDiff() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ns-logdiff-'));
  const mk = (name, list) => {
    const file = path.join(dir, name);
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE app_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, layer TEXT, level TEXT, kind TEXT, message TEXT)');
    const ins = db.prepare('INSERT INTO app_logs (id, ts, layer, level, kind, message) VALUES (?,?,?,?,?,?)');
    for (const x of list) ins.run(x.id, x.ts || '2026-09-15T00:00:00.000Z', x.layer || 'server', x.level || 'info', x.kind || 'lifecycle', x.message || '');
    db.close();
    return file;
  };
  const load = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const list = rows(db);
    db.close();
    return list;
  };
  let bad = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
    if (!ok) bad++;
  };

  // ① 阴性对照：副本是更早的采样，真实库多出正常日志 → **不许判红**
  const appLog = (id) => ({ id, layer: 'server', kind: 'workshop_tool_settings', message: `工具配置已加载（${id}）` });
  {
    const copy = load(mk('a-copy.db', [1, 2, 3].map(appLog)));
    const real = load(mk('a-real.db', [1, 2, 3, 4, 5, 6].map(appLog)));
    const d = classifyLogDiff(real, copy);
    const j = judgeLogDiff(d);
    check('副本更早 + 真实库正常增长 → 不判红',
      j.alarm === false && d.onlyRealNewer.length === 3 && d.onlyRealInside.length === 0,
      `newer=${d.onlyRealNewer.length} inside=${d.onlyRealInside.length} alarm=${j.alarm}`);
  }
  // ② 阳性对照：采样之后有探针特征的行写进真实库 → 必须判红
  {
    const copy = load(mk('b-copy.db', [1, 2, 3].map(appLog)));
    const real = load(mk('b-real.db', [1, 2, 3].map(appLog)
      .concat([{ id: 4, layer: 'server', kind: 'startup', message: 'verify-retrieval.mjs 端点实调 work=9' }])));
    const j = judgeLogDiff(classifyLogDiff(real, copy));
    check('采样后出现探针特征行 → 判红', j.alarm === true && j.suspiciousNewer.length === 1,
      `suspicious=${j.suspiciousNewer.length} alarm=${j.alarm}`);
  }
  // ③ 阳性对照：副本 id 范围内缺失（两库分叉 / 真实库被改写）→ 必须判红
  {
    const copy = load(mk('c-copy.db', [1, 2, 4, 5].map(appLog)));
    const real = load(mk('c-real.db', [1, 2, 3, 4, 5].map(appLog)));
    const d = classifyLogDiff(real, copy);
    const j = judgeLogDiff(d);
    check('副本范围内缺失（分叉） → 判红', j.alarm === true && d.onlyRealInside.length === 1,
      `inside=${d.onlyRealInside.length} alarm=${j.alarm}`);
  }

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响判据结论 */ }
  console.log(`\n判据自检：${bad ? `未通过（${bad} 条）` : '通过 3 / 3'}`);
  return bad ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain && process.argv.includes('--self-test')) process.exit(selfTestLogDiff());
if (isMain) main();
