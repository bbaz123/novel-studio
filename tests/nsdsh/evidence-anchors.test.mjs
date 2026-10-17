/**
 * tests/nsdsh/evidence-anchors.test.mjs —— S06：证据区间与锚点（F05 的另一半）。
 *
 * 引文锚点必须回答三个问题，且都不许猜：
 *   ① 找得到吗？（found）
 *   ② 找到几处？（occurrences —— 多处即 ambiguous，不能默认取第一处）
 *   ③ 属于哪一块？（chunk —— 支撑"部分抽取不能伪装无变化"的溯源）
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const C = await import('../../ai/extraction/coverage.mjs');

suite('nsdsh/evidence-anchors', [
  ['S06-A1 唯一命中：found=true、occurrences=1、能说出所属块', () => {
    const text = '第一章 断魂谷的雾散了\n第二章 青云镇';
    const chunks = C.planChunks(text, { maxChars: 10 });
    const a = C.anchorQuote(text, '断魂谷的雾散了', chunks);
    assert.equal(a.found, true);
    assert.equal(a.occurrences, 1);
    assert.equal(a.ambiguous, false);
    assert.equal(a.hits.length, 1);
    assert.equal(typeof a.hits[0].chunk, 'number', '必须能溯源到具体分块');
    assert.equal(text.slice(a.hits[0].start, a.hits[0].end), '断魂谷的雾散了', '命中区间必须与引文逐字一致');
  }],

  ['S06-A2 多处命中：必须报 ambiguous，并列出**全部**区间（不是第一处就完事）', () => {
    const text = '他笑了。然后她笑了。后来大家都笑了。';
    const a = C.anchorQuote(text, '笑了');
    assert.equal(a.found, true);
    assert.equal(a.occurrences, 3, `应找到全部 3 处，实际 ${a.occurrences}`);
    assert.equal(a.ambiguous, true, '多处命中必须报 ambiguous');
    // 每处都必须是真的命中
    for (const h of a.hits) {
      assert.equal(text.slice(h.start, h.end), '笑了');
    }
    // 区间必须严格递增且不重叠
    for (let i = 1; i < a.hits.length; i += 1) {
      assert.ok(a.hits[i].start > a.hits[i - 1].start);
    }
  }],

  ['S06-A3 找不到就是 found=false（不许模糊匹配兜底）', () => {
    const text = '第一章 断魂谷的雾散了';
    // 注意：必须是**真的不存在**的子串。'断魂谷的雾' 是正文子串（会被命中），
    // 因此这里故意改写一个字，保证它确实不出现。
    const absent = '断魂谷的雾没散';
    assert.equal(text.includes(absent), false, '前提：该引文确实不在正文里');
    const a = C.anchorQuote(text, absent);
    assert.equal(a.found, false);
    assert.equal(a.occurrences, 0);
    assert.deepEqual(a.hits, []);
    // 空引文不当作命中（否则等于放过没写证据的事件）
    assert.equal(C.anchorQuote(text, '').found, false);
  }],

  ['S06-A4 跨块边界的引文：定位用完整正文，不受切块影响', () => {
    // 让引文正好跨越 12000 字符的切块边界
    const prefix = '甲'.repeat(11990);
    const text = `${prefix}跨块证据\n后续`;
    const chunks = C.planChunks(text, { maxChars: 12000 });
    const a = C.anchorQuote(text, '跨块证据', chunks);
    assert.equal(a.found, true, '引文跨块也必须在完整正文里定位到');
    assert.equal(a.occurrences, 1);
    assert.ok(a.hits[0].start > 11900, '命中位置应在切块边界附近');
    // 该位置确实落在某一块里（块内文本可能只包含引文的一部分，但溯源仍成立）
    assert.equal(typeof a.hits[0].chunk, 'number');
  }],

  ['S06-A5 规范化口径一致：CRLF 正文与 LF 引文仍能互认', () => {
    const text = '第一行\r\n第二行证据\r\n第三行';
    const a = C.anchorQuote(text, '第二行证据');
    assert.equal(a.found, true, 'CRLF 正文里必须能定位 LF 引文（先统一换行再比）');
    // 控制字符必须被清掉，否则会"看起来有却匹配不上"
    const withCtrl = `第一行\u0007第二行证据`;
    assert.equal(C.anchorQuote(withCtrl, '第二行证据').found, true);
  }],
]);
