/**
 * tests/nsdsh/extraction-coverage.test.mjs —— S06：完整覆盖（修 F05）。
 *
 * 病灶再述：旧 `sanitizeText` 把正文硬截断到 12,000 字符，
 * 于是**第 12,001 字符之后的证据永远检索不到**，而调用方看不出被截过。
 * 这里钉住：
 *   ① 分块必须**连续、无重叠、无缝隙**、完整覆盖 [0,len)；
 *   ② 超过 12,000 字符的正文里，靠后的引文**仍然能被定位到**（这就是 F05 的核心）；
 *   ③ 覆盖清单必须如实报告 complete/gaps（不许"看起来完整"）。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const C = await import('../../ai/extraction/coverage.mjs');

/** 造一段长度可控、带段落边界的正文。 */
function longText(paragraphs, perParagraph) {
  const body = '甲'.repeat(perParagraph);
  return Array.from({ length: paragraphs }, (_, i) => `第${i + 1}段 ${body}`).join('\n');
}

suite('nsdsh/extraction-coverage', [
  ['S06-C1 分块连续、无重叠、无缝隙，完整覆盖全文', () => {
    const text = longText(40, 800); // ~32k 字符
    const chunks = C.planChunks(text, { maxChars: 12000 });
    assert.ok(chunks.length >= 3, `应切出多块，实际 ${chunks.length}`);
    // 逐块检查：第一块从 0 开始，每块的 start === 上一块 end，最后一块到 len
    assert.equal(chunks[0].start, 0);
    for (let i = 1; i < chunks.length; i += 1) {
      assert.equal(chunks[i].start, chunks[i - 1].end, `第 ${i} 块起点必须等于上一块终点`);
    }
    assert.equal(chunks[chunks.length - 1].end, text.length);
    // 总覆盖长度必须等于全文
    const covered = chunks.reduce((n, c) => n + c.chars, 0);
    assert.equal(covered, text.length, '覆盖长度必须等于全文长度');
  }],

  ['S06-C2 覆盖清单：完整时 complete=true，人为制造缝隙时能查出来', () => {
    const text = longText(10, 500);
    const chunks = C.planChunks(text, { maxChars: 1200 });
    const m = C.coverageManifest(text, chunks);
    assert.equal(m.complete, true, `应当完整：gaps=${JSON.stringify(m.gaps)}`);
    assert.equal(m.total, text.length);
    assert.equal(m.covered, text.length);
    assert.equal(m.gaps.length, 0);

    // 阴性对照：把一个块挖掉，必须报出缝隙（证明清单不是恒真）
    const broken = chunks.map((c, i) => (i === 1 ? { ...c, start: c.start + 10 } : c));
    const m2 = C.coverageManifest(text, broken);
    assert.equal(m2.complete, false, '人为制造缝隙后必须报 incomplete');
    assert.ok(m2.gaps.length > 0, '必须列出缝隙区间');
  }],

  ['S06-C3 F05 核心：12,000 字符之后的引文仍然能定位', () => {
    const near = '开头就出现的证据';
    const far = '结尾处的关键证据';
    const filler = '乙'.repeat(13000); // 让 far 落在 12,000 之后
    const text = `${near}\n${filler}\n${far}`;
    assert.ok(text.length > 13000);

    // 旧行为模拟：截断到 12000 会丢掉 far
    assert.equal(text.slice(0, 12000).includes(far), false, '前提：far 确实在 12000 之后');

    const chunks = C.planChunks(text, { maxChars: 12000 });
    const hits = C.locateQuote(text, far);
    assert.equal(hits.length, 1, 'far 必须能在**完整正文**里定位到');
    const chunk = C.chunkAt(chunks, hits[0].start);
    assert.ok(chunk, '必须能说出这条证据属于哪一块');
    assert.ok(chunk.index >= 1, `far 应落在靠后的块，实际第 ${chunk.index} 块`);

    // 覆盖清单证明"没有丢"：搜全部块，far 在其中一块里
    const foundInChunks = chunks.some((c) => text.slice(c.start, c.end).includes(far));
    assert.equal(foundInChunks, true, '分块结果里必须包含 far（证明未丢内容）');
  }],

  ['S06-C4 优先在换行处切块（不劈句）；找不到换行才硬切并标记', () => {
    const text = longText(6, 400);
    const chunks = C.planChunks(text, { maxChars: 800 });
    // 段落式文本：非最后一块应当以换行结束（即切在边界上）
    for (const c of chunks.slice(0, -1)) {
      if (!c.hardCut) assert.equal(text[c.end - 1], '\n', '软切必须落在换行后');
    }
    // 无换行的连续文本 → 必须硬切，且被如实标记
    const solid = '丙'.repeat(3000);
    const hard = C.planChunks(solid, { maxChars: 1000 });
    assert.ok(hard.slice(0, -1).every((c) => c.hardCut === true), '没有换行时必须标记 hardCut');
    assert.equal(C.coverageManifest(solid, hard).complete, true, '硬切也必须完整覆盖');
  }],

  ['S06-C5 空文本与边界值不崩，且覆盖清单如实', () => {
    assert.equal(C.planChunks('').length, 1);
    assert.equal(C.coverageManifest('', C.planChunks('')).complete, true);
    const one = C.planChunks('x');
    assert.deepEqual({ s: one[0].start, e: one[0].end }, { s: 0, e: 1 });
    // maxChars 传非法值不应产生空洞
    const weird = C.planChunks('abcdef', { maxChars: 0 });
    assert.equal(C.coverageManifest('abcdef', weird).complete, true);
  }],
]);
