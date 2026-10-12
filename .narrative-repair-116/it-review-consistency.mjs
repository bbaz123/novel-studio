/**
 * 集成验证（隔离实例 + 临时库，零真实写入）：
 *   `PUT /api/novel/review`（含自洽检测）→ 落库 → `GET /api/novel/review` 回读
 * 断言的是**我这条链路真正要保证的事**：
 *   ① 响应回带 consistency 与分开的计数；
 *   ② 落库后回读仍然带着它（"落库可追溯"这句必须在回读路径上成立）；
 *   ③ conflicts 与 advisories 分开计数，且**不互相混入**；
 *   ④ 阴性对照：正常报告不会被报成矛盾。
 */
import { makeIsolatedDataDir, startIsolatedServer, BASE } from './paid-eval-harness.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const cfg = makeIsolatedDataDir();
process.env.NOVELSTUDIO_DATA_DIR = cfg.dir;
const { stop } = await startIsolatedServer(cfg.dir);

const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json };
};

const results = [];
const rec = (id, desc, pass, detail) => { results.push({ id, desc, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}  — ${detail}`); };

try {
  // 建作品 + 章节（正文里有解释句，用于触发可确证的 strength_vs_body）
  const w = await api('POST', '/api/works', { title: 'IT-闭环验证', description: '' });
  const wid = w.json && (w.json.id || (w.json.work && w.json.work.id));
  const ch = await api('POST', '/api/chapters', {
    work_id: wid, title: '第1章',
    content: '<p>她低下头，把掌心摊开。</p><p>他从小就觉得，人拿到一样东西时手会先紧一下。</p>',
  });
  const cid = ch.json && (ch.json.id || (ch.json.chapter && ch.json.chapter.id));
  rec('IT0', '隔离实例可建作品与章节', !!wid && !!cid, `work=${wid} chapter=${cid}`);

  // ① 一份同时含**可确证矛盾**与**建议核对**的报告：
  //    · strength#1：「伏笔完全没有解释」× 正文有解释句 → `strength_vs_body`（可确证，给反例原文）
  //    · strength#2：「对白完全没有推进信息」与 issue#2 共享"对白/信息"→ `strength_vs_issue_overlap`（仅建议核对）
  //    注：advisories 的触发是**窄**的（要求 strength 带绝对措辞、且话题实词真重叠），这是刻意设计——
  //    宽松版在 12 份真实报告上误报 6 份（见 verify-round-20261011.md §2）。
  const rep = {
    summary: '总评：结构完整。',
    strengths: [
      '林清雪的伏笔完全没有解释，留得干净。',
      '本章对白完全没有推进信息，读起来很拖。',
      '等级分量全靠事件给出，不靠旁白建体系。',
    ],
    issues: [
      '篇幅与节奏：本章偏短。',
      '对白信息量不足：多处对话没有推进情节。',
    ],
  };
  const put = await api('PUT', '/api/novel/review', { chapter_id: cid, work_id: wid, report: rep, status: 'parsed' });
  rec('IT1', 'PUT /novel/review 201 且回带 consistency',
    put.status === 201 && !!put.json && !!put.json.consistency,
    JSON.stringify({ status: put.status, conflicts: put.json && put.json.consistency_conflicts, advisories: put.json && put.json.consistency_advisories }));
  rec('IT2', '可确证矛盾进 conflicts（strength_vs_body）',
    !!put.json && put.json.consistency && put.json.consistency.conflicts.some((c) => c.type === 'strength_vs_body'),
    JSON.stringify((put.json && put.json.consistency && put.json.consistency.conflicts || []).map((c) => c.type)));
  rec('IT3', '话题重叠进 advisories（strength_vs_issue_overlap），**不得**混进 conflicts',
    !!put.json && put.json.consistency_advisories >= 1
    && (put.json.consistency.advisories || []).some((a) => a.type === 'strength_vs_issue_overlap')
    && !(put.json.consistency.conflicts || []).some((a) => a.type === 'strength_vs_issue_overlap'),
    JSON.stringify({ advisories: put.json && put.json.consistency_advisories, types: (put.json && put.json.consistency && put.json.consistency.advisories || []).map((a) => a.type) }));
  rec('IT3b', '无绝对措辞的普通优点**不产生** advisories（不过度报警）',
    !!put.json && !(put.json.consistency.advisories || []).some((a) => String(a.strength).includes('不靠旁白建体系')),
    JSON.stringify((put.json && put.json.consistency && put.json.consistency.advisories || []).map((a) => String(a.strength).slice(0, 18))));
  rec('IT4', 'conflicts 与 advisories **分开计数**（不得合并）',
    !!put.json && typeof put.json.consistency_conflicts === 'number' && typeof put.json.consistency_advisories === 'number'
    && put.json.consistency_conflicts !== undefined && put.json.consistency_advisories !== undefined,
    JSON.stringify({ conflicts: put.json && put.json.consistency_conflicts, advisories: put.json && put.json.consistency_advisories }));

  // ② 回读路径
  const get = await api('GET', `/api/novel/review?chapter_id=${cid}`);
  const back = get.json && get.json.review && get.json.review.report;
  rec('IT5', 'GET 回读仍带 consistency（"落库可追溯"在回读路径上成立）',
    get.status === 200 && !!back && !!back.consistency,
    JSON.stringify({ parsed: get.json && get.json.review && get.json.review.parsed, has: !!(back && back.consistency) }));
  rec('IT6', '回读的 conflicts/advisories 内容与写入一致',
    !!back && back.consistency
    && Array.isArray(back.consistency.conflicts) && back.consistency.conflicts.length === put.json.consistency.conflicts.length
    && Array.isArray(back.consistency.advisories) && back.consistency.advisories.length === put.json.consistency.advisories.length,
    JSON.stringify({ c: back && back.consistency && back.consistency.conflicts.length, a: back && back.consistency && back.consistency.advisories.length }));

  // ③ 阴性对照：干净报告不得被判矛盾
  const clean = await api('PUT', '/api/novel/review', {
    chapter_id: cid, work_id: wid,
    report: { summary: '总评：不错。', strengths: ['动作干净。'], issues: ['节奏略快。'] }, status: 'parsed',
  });
  rec('IT7', '阴性对照：正常报告 status=ok 且 conflicts=0（不误伤）',
    clean.status === 201 && !!clean.json.consistency && clean.json.consistency.status === 'ok'
    && clean.json.consistency.conflicts.length === 0,
    JSON.stringify({ status: clean.json && clean.json.consistency && clean.json.consistency.status }));
} catch (e) {
  console.log('集成验证异常:', e && e.message ? e.message : e);
  results.push({ id: 'IT-ERR', pass: false, detail: String(e && e.message) });
} finally {
  stop();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n==== 集成汇总: ${results.length - failed.length}/${results.length} 通过 ====`);
if (failed.length) console.log('失败项:', failed.map((f) => f.id).join(', '));
fs.writeFileSync('.narrative-repair-116/it-review-consistency.json', JSON.stringify({ results }, null, 2));
try { fs.rmSync(cfg.dir, { recursive: true, force: true }); } catch (_) {}
process.exit(failed.length ? 1 : 0);
