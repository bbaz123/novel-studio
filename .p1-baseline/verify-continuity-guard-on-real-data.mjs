#!/usr/bin/env node
/**
 * verify-continuity-guard-on-real-data.mjs —— 用**真实数据 + 真实审稿报告**给确定性预检做首轮测量。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 2026-09-22 报告的通过线是：「在可确定复现的 4 条里至少复现 2 条、且误报 ≤1 条/章，
 * 才允许扩面」。这条线只能在真实章节上量——合成夹具能证明判据写对了，
 * 证明不了「它在你的作品上真的说出有用的话、且不吵」。
 *
 * 三条判据（与报告一致）：
 *   1. **命中**：期望类别必须真的被报出来（缺一条即失败）；
 *   2. **误报**：明确不该报的类别必须不出现——注意判的是**当前定稿**，
 *      而两份审稿报告针对的是**更早的草稿**（时间线：审稿 12:52 / 13:32，章节最后修改 13:17 / 14:04）。
 *      最典型的一处：第 6 章审稿写「约五千字以上（估 5000–5600 字）」，而当前定稿是 3897 字
 *      （3000～5000 区间内）→ 这一项现在**必须不报**，报了才是误报。
 *   3. **豁免闭环**：把本章 findings 全部标成"这是故意的"之后，必须一条都不剩
 *      （证明 `category:entity_id` 这个键真的对得上——豁免键写错会静默失效，界面上看不出来）。
 *
 * 用法:
 *   node .p1-baseline/verify-continuity-guard-on-real-data.mjs                 # 默认 data/novel.db + work 18
 *   node .p1-baseline/verify-continuity-guard-on-real-data.mjs --db <path> --work <id> --verbose
 *
 * 退出码：0 = 三条判据均成立；1 = 期望未达成（判据回归）；2 = 没有可测数据（套件按"跑不了"处理）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { computeContinuityGuard } from '../ai/continuity-guard-source.mjs';
import { findingKey } from '../ai/continuity-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DB = path.resolve(REPO, arg('--db', 'data/novel.db'));
const WORK = Number(arg('--work', '18'));
const VERBOSE = process.argv.includes('--verbose');

/**
 * 期望表：只写**能被报告原文追溯**的条目（每条都注明依据），不写"我觉得应该报"。
 *   required：必须出现（缺 = 漏报）
 *   banned  ：必须不出现（出现 = 误报；只在当前定稿上成立的事实才敢这么写）
 *   allowed ：允许出现但不要求（例如数据一变就会自然出现的项）
 * 未列入三者中任何一档的类别会被当成"未归类"，计入误报候选并打印出来——
 * 宁可让人看到多出来的东西，也不要静默吞掉。
 */
const EXPECTATIONS = {
  18: [
    {
      chapterId: 123, label: '第五章',
      required: ['character_time_point', 'system_frequency', 'chapter_length_target_conflict'],
      banned: ['chapter_length_over', 'plotline_stalled', 'plotline_not_started'],
      allowed: [],
      basis: '审稿报告 id=2（12:52）第 1 条＝角色卡时点；第 10 条＝系统面板/出场频率；'
        + '篇幅那条的根因是「章节目标 3000 vs 风格默认 4000」两套口径。',
    },
    {
      chapterId: 124, label: '第六章',
      required: ['character_time_point', 'chapter_length_target_conflict'],
      banned: ['chapter_length_over', 'plotline_stalled', 'plotline_not_started'],
      allowed: ['system_frequency'],
      basis: '审稿报告 id=3（13:32）第 1 条＝角色提前亮相/错置学校（角色卡时点）；'
        + '篇幅那条针对旧草稿（现定稿 3897 字，在 3000～5000 内），故 banned 里明确要求它**不报**。',
    },
  ],
};

if (!fs.existsSync(DB)) {
  console.log(`跳过：找不到数据库 ${DB}`);
  process.exitCode = 2;
} else {
  const db = new DatabaseSync(DB, { readOnly: true });
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);

  const written = all(
    "SELECT id, position, title, target_words, updated_at FROM chapters WHERE work_id = ? AND LENGTH(TRIM(COALESCE(content,''))) > 0 ORDER BY position",
    WORK,
  );
  console.log(`数据库：${path.relative(REPO, DB).replace(/\\/g, '/')}｜作品：work#${WORK}｜已写正文：${written.length} 章`);
  if (!written.length) {
    console.log('跳过：该作品没有已写正文的章节（没有可测量的对象）');
    process.exitCode = 2;
  } else {
    const reviews = all('SELECT id, chapter_id, created_at FROM chapter_reviews WHERE work_id = ?', WORK);
    for (const r of reviews) {
      const ch = written.find((c) => Number(c.id) === Number(r.chapter_id));
      if (ch) console.log(`  ⚠️ 审稿 #${r.id}（${r.created_at}）针对的是 ${ch.title} 的**更早草稿**`
        + `（该章最后修改 ${ch.updated_at}）——对照时按类别比，不按逐字比。`);
    }

    const perChapter = [];
    for (const ch of written) {
      const { ok, result } = computeContinuityGuard({ all, get }, { workId: WORK, chapterId: ch.id });
      if (!ok) { console.log(`  ✗ ${ch.title}：装配失败`); process.exitCode = 1; continue; }
      perChapter.push({ ch, result });
      console.log(`\n【${ch.title}】（id=${ch.id}，${result.checked.plainLength} 字）`);
      if (!result.findings.length) console.log('  · 无发现');
      for (const f of result.findings) {
        console.log(`  · [${f.severity}] ${f.category} — ${f.message}`);
        if (VERBOSE && f.suggestion) console.log(`      建议：${f.suggestion}`);
      }
    }

    const exp = EXPECTATIONS[WORK];
    let hits = 0; let misses = 0; let falsePositives = 0;
    if (exp) {
      console.log('\n── 与真实审稿报告的对照（期望表） ──');
      for (const e of exp) {
        const row = perChapter.find((p) => Number(p.ch.id) === Number(e.chapterId));
        if (!row) { console.log(`  ✗ ${e.label}：找不到该章（期望表中的 chapterId=${e.chapterId}）`); misses++; continue; }
        const cats = new Set(row.result.findings.map((f) => f.category));
        const missing = e.required.filter((c) => !cats.has(c));
        const banned = e.banned.filter((c) => cats.has(c));
        const unclassified = [...cats].filter((c) => !e.required.includes(c) && !e.banned.includes(c) && !e.allowed.includes(c));
        hits += e.required.length - missing.length;
        misses += missing.length;
        falsePositives += banned.length + unclassified.length;
        console.log(`  ${missing.length || banned.length || unclassified.length ? '✗' : '✓'} ${e.label}`);
        console.log(`      依据：${e.basis}`);
        console.log(`      命中 ${e.required.length - missing.length}/${e.required.length}`
          + `${missing.length ? `｜漏报：${missing.join('、')}` : ''}`
          + `${banned.length ? `｜误报（banned）：${banned.join('、')}` : ''}`
          + `${unclassified.length ? `｜未归类（需人工看）：${unclassified.join('、')}` : ''}`);
      }

      // 豁免闭环：把本章全部 findings 标为"故意的"，应当一条不剩。
      console.log('\n── 豁免闭环（阴性对照） ──');
      let exemptionOk = true;
      for (const p of perChapter) {
        const keys = p.result.findings.map(findingKey);
        if (!keys.length) continue;
        const after = computeContinuityGuard({ all, get }, { workId: WORK, chapterId: p.ch.id, exemptions: keys });
        const left = after.result.findings.length;
        if (left !== 0) { exemptionOk = false; console.log(`  ✗ ${p.ch.title}：豁免 ${keys.length} 条后仍有 ${left} 条未过滤（键对不上）`); }
      }
      if (exemptionOk) console.log('  ✓ 全部命中项都能被豁免键精确过滤掉（键 = category:entity_id）');

      const totalFindings = perChapter.reduce((s, p) => s + p.result.findings.length, 0);
      const pass = misses === 0 && falsePositives === 0 && exemptionOk && hits >= 2;
      console.log('\n══════════════════════════════');
      console.log(`命中 ${hits}｜漏报 ${misses}｜误报 ${falsePositives}｜本轮全部发现 ${totalFindings} 条`
        + `（${perChapter.map((p) => p.result.findings.length).join('/')} 条/章）`);
      console.log(`结论：${pass ? '通过线成立（命中 ≥2、误报 0、豁免闭环成立）' : '未达通过线，详见上面逐条'}`);
      process.exitCode = pass ? 0 : 1;
    } else {
      console.log(`\n（work#${WORK} 不在期望表里：本次只打印发现，不做命中/误报判定。`
        + '要加期望，请把该作品的审稿报告依据写进本文件的 EXPECTATIONS。）');
      process.exitCode = 0;
    }
  }
}
