#!/usr/bin/env node
/**
 * 上下文基线抓取（P1-c）。
 *
 * 对**隔离实例**（数据目录是真实库的副本）逐个作品/章节/模式抓取装配结果，
 * 落成可复现的 JSON 基线，并输出分层长度剖面。
 *
 * 基线的作用：P2 重建装配器后，用同一份输入产出结果与它逐层对照——
 * 这是「证明改动没有丢内容」的唯一客观手段（免费、可回归）。
 *
 * 用法:
 *   node capture-baseline.mjs --base http://127.0.0.1:3738 --db .p1-baseline/data/novel.db
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const BASE = arg('--base', 'http://127.0.0.1:3738');
const DB_PATH = arg('--db', '.p1-baseline/data/novel.db');
const OUT_DIR = arg('--out', '.p1-baseline/baselines');
const MODES = ['full', 'continuation', 'fragment', 'settings'];

// 与 server.js:1757-1773 一致的层标签顺序（用于把 assembled 切回各层）
const LABELS = [
  '作品',
  '卷/剧情线/章节进度（大纲）',
  '长期记忆（已发生的故事摘要）',
  '相关记忆检索（语义召回）',
  '最近事件（事件账本）',
  '未闭合伏笔（写作时必须照顾）',
  '当前场景',
  '本章蓝图（写作必须遵守）',
  '前文衔接',
  '出场角色卡',
  '人物关系',
  '激活的世界观设定（优先级排列）',
  '写作风格红线',
];

/** 把 assembled 按层头切分；返回 [{label, length, truncated}]（按出现顺序）。 */
function splitLayers(assembled) {
  const marks = [];
  let cursor = 0;
  for (const label of LABELS) {
    const token = `【${label}】`;
    const idx = assembled.indexOf(token, cursor);
    if (idx >= 0) {
      marks.push({ label, start: idx });
      cursor = idx + token.length;
    }
  }
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : assembled.length;
    const text = assembled.slice(start, end);
    out.push({
      label: marks[i].label,
      length: text.length,
      truncated: /已按预算截断/.test(text),
      empty: /】\n（(无|未指定|暂无)/.test(text),
    });
  }
  return out;
}

const rel = (p) => path.relative('.', path.resolve(p)).replace(/\\/g, '/');

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`非 JSON 响应 ${url}: ${text.slice(0, 200)}`);
  }
}

/** 量化 P3 路径（无预算）的输入规模：各字段的字符数。 */
function measureAIContext(ctx) {
  const len = (s) => (s ? String(s).length : 0);
  const characters = (ctx.characters || []).reduce(
    (n, c) => n + len(c.name) + len(c.identity) + len(c.personality) + len(c.background) + len(c.status) + len(c.mes_example) + len(c.system_prompt),
    0,
  );
  const world = (ctx.world_entries || []).reduce((n, w) => n + len(w.title) + len(w.content), 0);
  const recall = (ctx.semantic_recall?.hits || []).reduce((n, h) => n + len(h.text), 0);
  const events = (ctx.recent_events || []).reduce((n, e) => n + len(e.summary), 0);
  const foreshadows = (ctx.open_foreshadows || []).reduce((n, f) => n + len(f.summary), 0);
  return {
    characters, world, recall, events, foreshadows,
    story_memory: len(ctx.story_memory),
    story_tail: len(ctx.story_tail),
    style_contract: len(ctx.style_contract),
    raw_json: JSON.stringify(ctx).length,
    note: 'aiContextBlock 的渲染在浏览器侧（public/app.js:4834），此处量化其输入规模；渲染还会再叠加层标题与固定文案。',
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const works = db.prepare('SELECT id, title FROM works ORDER BY id').all();
  const targets = [];
  for (const w of works) {
    const chapters = db.prepare('SELECT id, position, title FROM chapters WHERE work_id = ? ORDER BY position, id').all(w.id);
    const pick = chapters.length <= 3 ? chapters : [chapters[0], chapters[Math.floor(chapters.length / 2)], chapters[chapters.length - 1]];
    for (const c of pick) targets.push({ work: w, chapter: c });
  }
  db.close();

  console.log(`隔离实例: ${BASE}`);
  console.log(`基线目标: ${targets.length} 个 (作品 × 章节)\n`);

  const summary = { base: BASE, db: rel(DB_PATH), captured_at: new Date().toISOString(), cases: [] };

  for (const t of targets) {
    for (const mode of MODES) {
      const url = `${BASE}/api/novel/context?work_id=${t.work.id}&chapter_id=${t.chapter.id}&mode=${mode}`;
      let ctx;
      try {
        ctx = await getJSON(url);
      } catch (e) {
        console.log(`  ✗ work#${t.work.id} chapter#${t.chapter.id} mode=${mode}: ${e.message}`);
        summary.cases.push({ work_id: t.work.id, chapter_id: t.chapter.id, mode, error: e.message });
        continue;
      }
      const assembled = ctx.assembled || '';
      const layers = splitLayers(assembled);
      const file = path.join(OUT_DIR, `w${t.work.id}-c${t.chapter.id}-${mode}.json`);
      fs.writeFileSync(file, JSON.stringify(ctx, null, 2), 'utf8');
      const caseRow = {
        work_id: t.work.id,
        work_title: t.work.title,
        chapter_id: t.chapter.id,
        mode,
        assembled_length: assembled.length,
        layer_count: layers.length,
        layers,
        semantic_recall_status: ctx.semantic_recall?.status || 'unknown',
        file: rel(file),
      };
      summary.cases.push(caseRow);
      console.log(
        `  ✓ w${t.work.id}/c${t.chapter.id}/${mode.padEnd(12)} assembled=${String(assembled.length).padStart(6)}  层=${String(layers.length).padStart(2)}  召回=${caseRow.semantic_recall_status}`,
      );
    }

    // P3 路径：不带预算的结构化输入
    try {
      const aiCtx = await getJSON(`${BASE}/api/ai_context?chapter_id=${t.chapter.id}`);
      const file = path.join(OUT_DIR, `w${t.work.id}-c${t.chapter.id}-ai_context.json`);
      fs.writeFileSync(file, JSON.stringify(aiCtx, null, 2), 'utf8');
      const m = measureAIContext(aiCtx);
      summary.cases.push({ work_id: t.work.id, chapter_id: t.chapter.id, mode: 'ai_context(P3)', input_measure: m, file: rel(file) });
      console.log(
        `  ✓ w${t.work.id}/c${t.chapter.id}/ai_context 输入规模: 角色卡=${m.characters} 世界观=${m.world} 长期记忆=${m.story_memory} 前文=${m.story_tail} 召回=${m.recall}`,
      );
    } catch (e) {
      console.log(`  ✗ w${t.work.id}/c${t.chapter.id}/ai_context: ${e.message}`);
    }
  }

  const summaryFile = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n基线已落盘: ${rel(summaryFile)}`);

  // 逐层剖面（只看 full 模式，便于横向比较）
  const fullCases = summary.cases.filter((c) => c.mode === 'full');
  if (fullCases.length) {
    console.log('\n═══ full 模式逐层剖面（字符数）═══');
    const header = ['层'.padEnd(30), ...fullCases.map((c) => `w${c.work_id}/c${c.chapter_id}`.padStart(14))].join('');
    console.log(header);
    for (const label of LABELS) {
      const cells = fullCases.map((c) => {
        const l = (c.layers || []).find((x) => x.label === label);
        return (l ? `${l.length}${l.truncated ? '✂' : ''}${l.empty ? '∅' : ''}` : '-').padStart(14);
      });
      console.log([label.slice(0, 28).padEnd(30), ...cells].join(''));
    }
    console.log(['合计'.padEnd(30), ...fullCases.map((c) => String(c.assembled_length).padStart(14))].join(''));
    console.log('\n图例: ✂=被 cap 截断  ∅=空/占位  -=该层不存在');
  }
}

main().catch((e) => {
  console.error('基线抓取失败:', e.message);
  process.exit(1);
});
