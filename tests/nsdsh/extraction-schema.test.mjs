/**
 * tests/nsdsh/extraction-schema.test.mjs —— S06：提示词契约由 schema 生成（修 F06）。
 *
 * 病灶：提示词里的 domain / scope / 上限是**手写字符串**，与 `schema.mjs` 的真值各自漂移。
 * 这里钉住：
 *   ① 提示词列举的 domain / scope 与 schema 真值**完全一致**（不多不少）；
 *   ② 生成的示例**确实合法**（能被 cellKey 接受）；
 *   ③ 非法示例必须被拒绝（证明校验器真的在工作，不是恒通过）。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const PS = await import('../../ai/extraction/prompt-schema.mjs');
const S = await import('../../ai/story-state/temporal/schema.mjs');

suite('nsdsh/extraction-schema', [
  ['S06-S1 提示词契约与 schema 真值一致（domain / scope / 上限）', () => {
    const c = PS.promptContract();
    assert.deepEqual(c.domains, [...S.DOMAINS].sort(), 'F06：domain 列表必须来自 schema，不多不少');
    assert.deepEqual(c.scopes, [...S.SCOPES].sort(), 'F06：scope 列表必须来自 schema');
    assert.equal(c.response_constraints.max_ops_per_event, S.TEMPORAL_LIMITS.max_ops_per_event,
      'F06：每事件 ops 上限必须与 schema 一致（否则提示词与校验器互相矛盾）');
  }],

  ['S06-S2 生成的示例全部合法（能被 cellKey 接受）', () => {
    const examples = PS.exampleCells();
    assert.ok(examples.length >= 3, `至少 3 个示例，实际 ${examples.length}`);
    for (const e of examples) {
      assert.match(e.key, /^\[/, `示例 key 应当是 canonical JSON 数组，实际 ${e.key}`);
      // 再走一次 schema 的解析，确保它不是"字符串拼出来的假 key"
      assert.doesNotThrow(() => S.parseCellKey(e.key), `示例 key 必须能被 parseCellKey 解析：${e.key}`);
      const parsed = S.parseCellKey(e.key);
      assert.equal(parsed.domain, e.example.domain);
      assert.equal(parsed.scope, e.example.scope);
    }
  }],

  ['S06-S3 非法示例必须被拒绝（证明校验器真的在工作）', () => {
    assert.throws(() => PS.validateExample({ domain: '不存在的域', entityId: 'x', predicate: 'p' }), /INVALID_DOMAIN_OR_SCOPE/);
    assert.throws(() => PS.validateExample({ domain: 'character', entityId: 'x', predicate: 'p', scope: '不存在的范围' }), /INVALID_DOMAIN_OR_SCOPE/);
    assert.throws(() => PS.validateExample({ domain: 'character', entityId: '', predicate: 'p' }), /INVALID_ENTITY_ID/);
    assert.throws(() => PS.validateExample({ domain: 'character', entityId: 'x', predicate: '' }), /INVALID_PREDICATE/);
    // holder 只允许在 character scope 下出现
    assert.throws(() => PS.validateExample({ domain: 'character', entityId: 'x', predicate: 'p', scope: 'canon', holderId: 'y' }),
      /HOLDER_NOT_ALLOWED_FOR_SCOPE/);
  }],

  ['S06-S4 渲染出的提示词片段包含真值数量，便于发现漂移', () => {
    const text = PS.renderPromptContract();
    const c = PS.promptContract();
    assert.ok(text.includes(String(c.domains.length)), '片段里应出现 domain 数量');
    assert.ok(text.includes(String(c.response_constraints.max_ops_per_event)), '片段里应出现 ops 上限');
    // 每个 domain 都出现在提示词里（模型才不会"不敢用"新增的域）
    for (const d of c.domains) assert.ok(text.includes(d), `提示词缺少 domain：${d}`);
  }],
]);
