/**
 * tests/nsdsh/relation-direction.test.mjs —— S05：v2 关系方向规则。
 *
 * 旧数据只有 from/to 两个**名字**，既没有身份也没有方向语义。
 * v2 必须能回答：(A,B) 与 (B,A) 是不是同一条？方向怎么表达？
 * 规则在这里钉死：
 *   · 规范 key 按 uid 排序（所以 (A,B) 与 (B,A) 落到同一 key）；
 *   · 方向另存为 forward / inverse，不能靠"字符串不同"隐式表达；
 *   · 自反关系（A→A）单独一类，便于校验层拒绝或提示。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const ID = await import('../../ai/story-state/temporal/identity.mjs');

suite('nsdsh/relation-direction', [
  ['S05-R1 (A,B) 与 (B,A) 落到同一个 key，方向相反', () => {
    const ab = ID.canonicalRelation({ fromUid: 'ent:1', toUid: 'ent:2' });
    const ba = ID.canonicalRelation({ fromUid: 'ent:2', toUid: 'ent:1' });
    assert.equal(ab.key, ba.key, '同一对实体必须共用规范 key');
    assert.equal(ab.kind, ID.RELATION_KIND.FORWARD);
    assert.equal(ba.kind, ID.RELATION_KIND.INVERSE, '反向必须被显式标出来');
    assert.equal(ab.fromUid, 'ent:1');
    assert.equal(ba.fromUid, 'ent:2', '方向不能被规范化吃掉');
  }],

  ['S05-R2 不同对实体不得碰撞', () => {
    const a = ID.relationPairKey('ent:1', 'ent:2');
    const b = ID.relationPairKey('ent:1', 'ent:3');
    const c = ID.relationPairKey('ent:2', 'ent:3');
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
    // ent:1-ent:12 与 ent:11-ent:2 不能因为字符串拼接而碰撞
    assert.notEqual(ID.relationPairKey('ent:1', 'ent:12'), ID.relationPairKey('ent:11', 'ent:2'));
  }],

  ['S05-R3 自反关系单独分类', () => {
    const r = ID.canonicalRelation({ fromUid: 'ent:5', toUid: 'ent:5' });
    assert.equal(r.kind, ID.RELATION_KIND.SELF);
    assert.equal(r.key, 'rel:self:ent:5');
  }],

  ['S05-R4 非法输入必须响亮失败（不接受 v1 名称当 uid）', () => {
    assert.throws(() => ID.canonicalRelation({ fromUid: '王师傅', toUid: 'ent:2' }), /INVALID_ENTITY_UID/,
      'v1 的名称不是稳定身份，必须被拒绝');
    assert.throws(() => ID.canonicalRelation({ fromUid: 'ent:1' }), /MISSING_RELATION_ENDS/);
    assert.throws(() => ID.canonicalRelation({}), /MISSING_RELATION_ENDS/);
  }],
]);
