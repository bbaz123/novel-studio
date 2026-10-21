import { createChecks } from '../../../tests/narrative-repair/harness.mjs';
import { assertSubmitArgs, assertReadArgs, DIMENSIONS, OPERATIONS, RESOURCES } from '../lib/contracts.js';

const { check, finish } = createChecks();
check('C1', 'operation 只接受 blind_draft / final',
  OPERATIONS.join(',') === 'blind_draft,final'
    && assertSubmitArgs({ operation: 'final', payload: {} }).ok
    && assertSubmitArgs({ operation: 'blind_draft', payload: {} }).ok
    && !assertSubmitArgs({ operation: 'nope', payload: {} }).ok);
check('C2', 'payload 必须是对象（数组/null/字符串都拒绝）',
  !assertSubmitArgs({ operation: 'final', payload: [] }).ok
    && !assertSubmitArgs({ operation: 'final', payload: null }).ok
    && !assertSubmitArgs({ operation: 'final', payload: 'x' }).ok);
check('C3', 'resource 白名单固定，cursor/limit 被夹到合法范围',
  RESOURCES.includes('article') && RESOURCES.includes('candidate')
    && !assertReadArgs({ resource: 'secrets' }).ok
    && assertReadArgs({ resource: 'article', cursor: -5, limit: 999999 }).cursor === 0
    && assertReadArgs({ resource: 'article', cursor: -5, limit: 999999 }).limit === 20000);
check('C4', '九个审查维度齐全（缺一个就无法证明"规定维度都给了结论"）',
  DIMENSIONS.length === 9 && DIMENSIONS.includes('temporal_foreshadowing') && DIMENSIONS.includes('evidence_integrity'));
finish('插件契约');
