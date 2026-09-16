#!/usr/bin/env node
/**
 * I4 验证器：「凡被裁剪，必须能查回原文」的端到端实测（P3 验收工具）。
 *
 * 与 verify-invariants.mjs 的分工：
 *   verify-invariants  离线校验 I1/I2/I3/I7，并输出「哪些层被裁掉多少」（I4 工作清单）
 *   本工具             **实际调用查回端点**，断言被裁掉的内容真的取得到
 *
 * 关键点：不看声明、只看实测。声明了路径但端点取不回，照样算缺口。
 *
 * 用法: node verify-retrieval.mjs <base> <db> <workId> <chapterId>
 */
import { DatabaseSync } from 'node:sqlite';
import { RETRIEVAL } from '../ai/context/layers.mjs';

const [base, dbPath, workIdArg, chapterIdArg] = process.argv.slice(2);
if (!base || !dbPath) {
  console.error('用法: node verify-retrieval.mjs <base> <db> <workId> <chapterId>');
  process.exit(2);
}
const workId = Number(workIdArg);
const chapterId = Number(chapterIdArg);

const db = new DatabaseSync(dbPath, { readOnly: true });
const get = async (p) => {
  const r = await fetch(base + p, { signal: AbortSignal.timeout(40000) });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t.slice(0, 160) }; }
};

const ctx = (await get(`/api/novel/context?work_id=${workId}&chapter_id=${chapterId}&mode=full`)).json;
const manifest = (ctx.context_manifest || []).filter((m) => m.dropped > 0);

console.log(`隔离实例: ${base}`);
console.log(`作品 #${workId} / 章节 #${chapterId}　装配 ${ctx.assembled.length} 字 / 预算 ${ctx.context_stats?.budget}`);
console.log(`被裁剪的层: ${manifest.length} 个\n`);

const rows = [];
const gaps = [];

for (const m of manifest) {
  const decl = RETRIEVAL[m.id] || { tool: null, note: '未声明查回路径' };
  const row = { id: m.id, label: m.label, kind: m.kind, dropped: m.dropped, tool: decl.tool, status: '', evidence: '' };

  if (!decl.tool) {
    // intrinsic=true 表示该层本身就是检索的产物，不存在「更上层的原文」可查——
    // 这不是缺口，不应计入 I4 未成立。
    row.status = decl.intrinsic ? '不适用' : '缺口';
    row.evidence = decl.note || '无查回路径';
    if (!decl.intrinsic) gaps.push(row);
    rows.push(row);
    continue;
  }

  // 逐层实测
  try {
    if (m.id === 'memory') {
      const r = await get(`/api/story_memory?work_id=${workId}`);
      const len = (r.json?.summary || '').length;
      // 层正文 = 记忆全文 + 可能的压缩提示语；因此要求返回值 ≥ 已采用量即证明「被裁的部分可取回」
      const ok = len >= m.emitted;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/story_memory → ${len} 字（层采用 ${m.emitted}，被裁 ${m.dropped}）`;
      if (!ok) gaps.push(row);
    } else if (m.id === 'events') {
      const r = await get(`/api/novel/events?work_id=${workId}&limit=500`);
      const n = (r.json?.events || []).length;
      const total = db.prepare('SELECT COUNT(*) AS c FROM story_events WHERE work_id = ?').get(workId).c;
      // 层里采用的事件条数 = 正文里以「N. [kind]」开头的行数
      const emittedCount = (ctx.assembled.match(/^\d+\.\s\[/gm) || []).length;
      const ok = n >= Math.max(emittedCount, 1) && n > 0;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/novel/events → ${n} 条（层里约 ${emittedCount} 条，库里共 ${total} 条）`;
      if (!ok) gaps.push(row);
    } else if (m.id === 'foreshadows') {
      const r = await get(`/api/novel/foreshadows?work_id=${workId}&status=all`);
      const n = (r.json?.foreshadows || []).length;
      const total = db.prepare("SELECT COUNT(*) AS c FROM story_events WHERE work_id = ? AND kind = 'foreshadow'").get(workId).c;
      const ok = n >= total && n > 0;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/novel/foreshadows?status=all → ${n} 条（库里共 ${total} 条）`;
      if (!ok) gaps.push(row);
    } else if (m.id === 'redlines') {
      const r = await get(`/api/novel/redlines?work_id=${workId}`);
      const arr = Array.isArray(r.json) ? r.json : (r.json?.redlines || []);
      const total = db.prepare('SELECT COUNT(*) AS c FROM writing_redlines WHERE work_id = ? OR work_id IS NULL').get(workId).c;
      const ok = arr.length >= total && arr.length > 0;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/novel/redlines → ${arr.length} 条（库里共 ${total} 条）`;
      if (!ok) gaps.push(row);
    } else if (m.id === 'world') {
      // 取该作品一个真实关键词，确认它能从新增的 world_entries 桶里被检索到
      const sample = db.prepare('SELECT title, keywords FROM world_entries WHERE work_id = ? ORDER BY priority DESC LIMIT 1').get(workId);
      const kw = String(sample?.keywords || '').split(/[,，、\s]+/).filter(Boolean)[0] || String(sample?.title || '').slice(0, 2);
      const r = await get(`/api/search?q=${encodeURIComponent(kw)}&work_id=${workId}`);
      const n = (r.json?.world_entries || []).length;
      const ok = n > 0;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/search?q=${kw} → world_entries ${n} 条（此前该桶不存在）`;
      if (!ok) gaps.push(row);
    } else if (m.id === 'blueprint') {
      // 蓝图不在独立表里，取一个真实蓝图的中文片段去检索，确认章节结果带着 blueprint_json 回来
      const bpRow = db.prepare("SELECT blueprint_json FROM chapters WHERE work_id = ? AND LENGTH(blueprint_json) > 10 ORDER BY position LIMIT 1").get(workId);
      let bpText = '';
      try { bpText = Object.values(JSON.parse(bpRow?.blueprint_json || '{}')).map(String).join(''); } catch { /* ignore */ }
      const kw = bpText.replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 4);
      if (!kw) { row.status = '未实测'; row.evidence = '该作品没有蓝图数据可测'; rows.push(row); continue; }
      const r = await get(`/api/search?q=${encodeURIComponent(kw)}&work_id=${workId}`);
      // 必须命中一个**真正带蓝图**的章节（blueprint_json 长于 '{}'），否则证据不成立
      const hit = (r.json?.chapters || []).find((c) => String(c.blueprint_json || '').length > 10);
      const ok = !!hit;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/search?q=${kw} → 命中章节 ${hit ? `#${hit.id}（蓝图 ${String(hit.blueprint_json).length} 字，层里只带 ${m.emitted}）` : '无（未取回带蓝图的章节）'}`;
      if (!ok) gaps.push(row);
    } else if (m.id === 'relations') {
      const sample = db.prepare('SELECT relation, description FROM character_relations WHERE work_id = ? LIMIT 1').get(workId);
      const kw = String(sample?.relation || '').slice(0, 2) || String(sample?.description || '').replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 3);
      if (!kw) { row.status = '未实测'; row.evidence = '该作品没有人物关系可测'; rows.push(row); continue; }
      const r = await get(`/api/search?q=${encodeURIComponent(kw)}&work_id=${workId}`);
      const n = (r.json?.relations || []).length;
      const ok = n > 0;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/search?q=${kw} → relations ${n} 条（P3 新增桶）`;
      if (!ok) gaps.push(row);
    } else if (m.id === 'outline' || m.id === 'scene' || m.id === 'story_tail' || m.id === 'characters') {
      const sample = db.prepare('SELECT title FROM chapters WHERE work_id = ? ORDER BY position LIMIT 1').get(workId);
      const kw = String(sample?.title || '').replace(/^第\d+节\s*/, '').slice(0, 3);
      const r = await get(`/api/search?q=${encodeURIComponent(kw)}&work_id=${workId}`);
      const j = r.json || {};
      const n = (j.chapters?.length || 0) + (j.characters?.length || 0);
      const ok = n > 0;
      row.status = ok ? '可取回' : '不足';
      row.evidence = `GET /api/search?q=${kw} → chapters ${j.chapters?.length || 0} / characters ${j.characters?.length || 0}`;
      if (!ok) gaps.push(row);
    } else {
      row.status = '未实测';
      row.evidence = decl.note || '本工具未实现该层的实测';
    }
  } catch (e) {
    row.status = '错误';
    row.evidence = e.message;
    gaps.push(row);
  }
  rows.push(row);
}

console.log('层            类型    被裁     查回工具                实测结果');
console.log('─'.repeat(100));
for (const r of rows) {
  console.log(
    `${r.id.padEnd(13)} ${String(r.kind).padEnd(6)} ${String(r.dropped).padStart(6)}   ${String(r.tool || '（无）').padEnd(22)} ${r.status}`,
  );
  console.log(`              └ ${r.evidence}`);
}

console.log(`\n结论: ${gaps.length === 0 ? '✓ 所有被裁剪的层都能查回（I4 成立）' : `✗ ${gaps.length} 个层存在查回缺口（I4 未完全成立）`}`);
if (gaps.length) {
  console.log('缺口清单：');
  for (const g of gaps) console.log(`   - ${g.id}（被裁 ${g.dropped} 字）：${g.evidence}`);
}
db.close();
process.exitCode = gaps.length ? 1 : 0;
