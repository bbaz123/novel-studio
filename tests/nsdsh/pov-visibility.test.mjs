/**
 * tests/nsdsh/pov-visibility.test.mjs —— S07：POV 可见性（确定性过滤，禁止启发式）。
 *
 * 规则（方案明确"不加入'名称未出现则不失效'的启发式"）：
 *   · `reader` scope：只有**已披露**才可见 —— 披露与否由调用方给出，本层不猜；
 *   · `character` scope：只有 holder 是当前 POV 才可见（角色只能看到自己的知识）；
 *   · `canon` / `world`：世界事实，对任何人可见；
 *   · POV 未知时，`character` scope 一律**不可见**（宁可少给，不可把别人的知识当成自己的）。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const Q = await import('../../ai/story-state/temporal/state-query.mjs');

suite('nsdsh/pov-visibility', [
  ['S07-V1 character scope：只有自己的知识可见', () => {
    const own = Q.povVisible({ scope: 'character', holderId: '甲', povCharacterId: '甲' });
    assert.equal(own.visible, true);
    assert.equal(own.reason, 'OWN_KNOWLEDGE');

    const other = Q.povVisible({ scope: 'character', holderId: '乙', povCharacterId: '甲' });
    assert.equal(other.visible, false, '不能把别人的知识当成当前 POV 的事实');
    assert.equal(other.reason, 'OTHER_CHARACTER');
  }],

  ['S07-V2 POV 未知时一律不可见（不猜"大概是主角"）', () => {
    const r = Q.povVisible({ scope: 'character', holderId: '甲', povCharacterId: null });
    assert.equal(r.visible, false);
    assert.equal(r.reason, 'POV_UNKNOWN');
    assert.equal(Q.povVisible({ scope: 'character', holderId: '甲' }).visible, false);
  }],

  ['S07-V3 reader scope：未披露即不可见，已披露才可见（披露由调用方给）', () => {
    assert.equal(Q.povVisible({ scope: 'reader', disclosed: false }).visible, false);
    assert.equal(Q.povVisible({ scope: 'reader', disclosed: false }).reason, 'NOT_DISCLOSED');
    assert.equal(Q.povVisible({ scope: 'reader', disclosed: true }).visible, true);
    // 不传 disclosed 视为未披露（默认不可见，而不是默认可见）
    assert.equal(Q.povVisible({ scope: 'reader' }).visible, false, '缺省必须是不可见');
  }],

  ['S07-V4 canon / world：世界事实对任何人可见', () => {
    assert.equal(Q.povVisible({ scope: 'canon', povCharacterId: '甲' }).visible, true);
    assert.equal(Q.povVisible({ scope: 'world', povCharacterId: null }).visible, true);
    assert.equal(Q.povVisible({ scope: 'canon' }).reason, 'SCOPE_PUBLIC');
  }],

  ['S07-V5 一致性：同一 scope 不同 holder 不得因为字符串宽松而互相可见', () => {
    // 空 holder 不能被当成"任意 POV 都算自己"
    assert.equal(Q.povVisible({ scope: 'character', holderId: '', povCharacterId: '甲' }).visible, false);
    // null holder 同理
    assert.equal(Q.povVisible({ scope: 'character', holderId: null, povCharacterId: '甲' }).visible, false);
    // 数字与字符串 id 只要值相同就算同一角色（不要让类型差异导致"自己看不到自己"）
    assert.equal(Q.povVisible({ scope: 'character', holderId: 7, povCharacterId: '7' }).visible, true);
  }],
]);
