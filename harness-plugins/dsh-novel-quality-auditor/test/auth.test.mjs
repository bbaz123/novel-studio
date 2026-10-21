import { createChecks } from '../../../tests/narrative-repair/harness.mjs';
import { readEnv, notApplicableText } from '../lib/env.js';
import { requireActive, assertKind } from '../lib/auth.js';

const { check, finish } = createChecks();
const full = { NOVELSTUDIO_MODE: 'quality_audit', NOVELSTUDIO_AUDIT_ID: 'qa_1', NOVELSTUDIO_AUDIT_TOKEN: 't', NOVELSTUDIO_AUDIT_KIND: 'review', NOVELSTUDIO_BASE_URL: 'http://127.0.0.1:1/' };
const env = readEnv(full);
check('A1', '完整环境：active=true，baseUrl 去掉尾斜杠', env.active && env.baseUrl === 'http://127.0.0.1:1');
check('A2', '缺 token / 缺 mode 都不 active（并列出缺失项）',
  !readEnv({ ...full, NOVELSTUDIO_AUDIT_TOKEN: '' }).active
    && readEnv({ ...full, NOVELSTUDIO_AUDIT_TOKEN: '' }).missing.includes('NOVELSTUDIO_AUDIT_TOKEN')
    && !readEnv({ ...full, NOVELSTUDIO_MODE: 'novel' }).active);
check('A3', '非审计任务返回 NOT_APPLICABLE，不抛错也不干扰', (() => {
  const t = JSON.parse(notApplicableText(readEnv({})));
  return t.ok === false && t.applicable === false && t.code === 'NOT_APPLICABLE';
})());
check('A4', 'requireActive 在缺失时抛 NOT_APPLICABLE；assertKind 拒绝错配', (() => {
  let e1 = '';
  try { requireActive(readEnv({})); } catch (e) { e1 = e.code; }
  let e2 = '';
  try { assertKind(readEnv(full), 'revision'); } catch (e) { e2 = e.code; }
  return e1 === 'NOT_APPLICABLE' && e2 === 'AUDIT_PHASE_INVALID';
})());
finish('插件鉴权与环境');
