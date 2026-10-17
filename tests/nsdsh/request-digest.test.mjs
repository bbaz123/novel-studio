/**
 * tests/nsdsh/request-digest.test.mjs —— S06：版本化完整请求/响应摘要（修 F07 / F08）。
 *
 * F07 的两个易错点（本套件逐条钉住）：
 *   ① **缺失 ≠ 空**：没提供状态 与 提供了空状态 必须是不同摘要，
 *      否则"未提供的状态"会被下游当成 missing（把"没有这一项"误读成"这一项是空"）。
 *   ② 摘要必须覆盖**决定请求长什么样**的全部输入：已知实体、选入状态、lineage、身份版本、模型路由。
 * F08：响应摘要必须基于**完整**输出 —— 只改第 2,000 字符之后的内容，摘要也必须变。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const D = await import('../../ai/extraction/digest.mjs');

const base = { system: 'sys', user: 'usr', knownEntities: ['甲', '乙'], selectedState: { k1: 1 }, lineage: 'lin-1', identityVersion: 'IDV-1', modelRoute: 'deepseek-chat', extractionVersion: '1.0.0' };

suite('nsdsh/request-digest', [
  ['S06-D1 同一输入摘要稳定；任一决定项变化都必须改变摘要', () => {
    const a = D.requestDigestV2(base);
    const b = D.requestDigestV2({ ...base });
    assert.equal(a.digest, b.digest, '同一输入必须得到同一个摘要');
    assert.equal(a.version, 'v2');

    const mutations = {
      已知实体: { ...base, knownEntities: ['甲', '乙', '丙'] },
      选入状态: { ...base, selectedState: { k1: 2 } },
      lineage: { ...base, lineage: 'lin-2' },
      身份版本: { ...base, identityVersion: 'IDV-2' },
      模型路由: { ...base, modelRoute: 'other-model' },
      抽取版本: { ...base, extractionVersion: '1.0.1' },
      系统提示: { ...base, system: 'sys2' },
      用户正文: { ...base, user: 'usr2' },
    };
    for (const [name, input] of Object.entries(mutations)) {
      assert.notEqual(D.requestDigestV2(input).digest, a.digest, `${name} 变化必须改变摘要（F07）`);
    }
  }],

  ['S06-D2 缺失 ≠ 空：未提供状态与提供空状态必须不同（不许把"没有"伪装成"空"）', () => {
    const missing = D.requestDigestV2({ ...base, selectedState: null, knownEntities: null });
    const empty = D.requestDigestV2({ ...base, selectedState: {}, knownEntities: [] });
    const omitted = D.requestDigestV2({ system: base.system, user: base.user });
    assert.notEqual(missing.digest, empty.digest, '未提供(null) 与 空表({}) 必须是不同摘要');
    assert.notEqual(missing.digest, omitted.digest, '显式 null 与 完全省略也必须是不同摘要');
    assert.equal(missing.payload.selected_state, null);
    assert.deepEqual(empty.payload.selected_state, {});
    assert.deepEqual(empty.payload.known_entities, []);
    assert.equal(missing.payload.known_entities, null);
  }],

  ['S06-D3 顺序不敏感：同一批实体/状态换顺序不得改变摘要', () => {
    const a = D.requestDigestV2({ ...base, knownEntities: ['甲', '乙', '丙'], selectedState: { b: 2, a: 1 } });
    const b = D.requestDigestV2({ ...base, knownEntities: ['丙', '乙', '甲'], selectedState: { a: 1, b: 2 } });
    assert.equal(a.digest, b.digest, '排序后再入摘要，避免"换顺序被当成不同请求"');
    // 重复项不得影响
    const c = D.requestDigestV2({ ...base, knownEntities: ['甲', '甲', '乙', '丙'], selectedState: { a: 1, b: 2 } });
    assert.equal(c.digest, a.digest, '重复的已知实体必须去重');
  }],

  ['S06-D4 F08：响应摘要必须覆盖完整输出（只改 2000 字符之后也要变）', () => {
    const head = 'H'.repeat(2500);
    const r1 = D.responseDigestV2(`${head}尾A`);
    const r2 = D.responseDigestV2(`${head}尾B`);
    assert.notEqual(r1.digest, r2.digest, 'F08：只改第 2000 字符之后的内容，摘要也必须变');
    assert.equal(r1.length, r2.length);
    // 旧实现只取前 2000 字符 → 这两个会得到同一个摘要；这里必须是不同
    const oldStyle = (s) => s.slice(0, 2000);
    assert.equal(oldStyle(`${head}尾A`), oldStyle(`${head}尾B`), '对照：旧口径确实看不出差别');
  }],

  ['S06-D5 超限必须如实标记，不得静默截断', () => {
    const big = 'X'.repeat(300);
    const r = D.responseDigestV2(big, { maxChars: 100 });
    assert.equal(r.overLimit, true, '超过明确上限必须标 overLimit');
    assert.equal(r.length, 300);
    assert.equal(r.truncatedLength, 100);
    const ok = D.responseDigestV2('Y'.repeat(50), { maxChars: 100 });
    assert.equal(ok.overLimit, false);
    assert.equal(ok.truncatedLength, 50);
  }],

  ['S06-D6 非法输入响亮失败（undefined 会被 JSON 悄悄丢掉 → 必须拒绝）', () => {
    assert.throws(() => D.canonicalize(undefined), /DIGEST_UNDEFINED_NOT_ALLOWED/);
    assert.throws(() => D.canonicalize(Number.NaN), /DIGEST_NON_FINITE_NUMBER/);
    // 嵌套 undefined 同样不许静默丢失
    assert.throws(() => D.canonicalize({ a: undefined }), /DIGEST_UNDEFINED_NOT_ALLOWED/);
  }],
]);
