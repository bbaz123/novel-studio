/**
 * coexistence.test.mjs —— 与 novel-writing / dsh-confirmation-resolution 共存的自动断言。
 *
 * CO-01：工具名、事件、补丁层三者都不冲突；
 * CO-02/CO-03：本插件代码里不出现 confirmation 账本动作（register/decide/complete/ledger/C 编号）；
 * 另外钉住"没有全局 post-execute"与"不写 system-prompt personaPrefix"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecks } from '../../../tests/narrative-repair/harness.mjs';
import { apply, TOOL_NAMES } from '../lib/index.js';

const { check, finish } = createChecks();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const REPO = path.resolve(PLUGIN, '..', '..');

const events = [];
const names = [];
apply({ tools: { register(d) { names.push(d.name); } }, on(e) { events.push(e); } }, {});
check('CO-01', '四个工具名唯一且全部带 novel_quality_ 前缀', names.length === 4 && names.every((n) => n.startsWith('novel_quality_')));
check('CO-02', '只注册 agent/turn-stopping 一个事件，没有全局 tools/post-execute',
  events.length === 1 && events[0] === 'agent/turn-stopping' && !events.some((e) => String(e).includes('post-execute')));

// novel-writing 的工具名（读真实源码，比硬编码清单可靠）
const novelSrc = fs.readFileSync(path.join(REPO, 'harness-plugins', 'novel-writing', 'novel-tools.mjs'), 'utf8');
const novelNames = [...novelSrc.matchAll(/register\(\s*'(novel_[a-z_]+)'/g)].map((m) => m[1]);
const collisions = TOOL_NAMES.filter((n) => novelNames.includes(n));
check('CO-03', '与 novel-writing 的工具名无覆盖/重复', novelNames.length > 10 && collisions.length === 0,
  `novel=${novelNames.length} collisions=${collisions.join(',')}`);

// 补丁层：不碰系统提示与全局钩子
const patch = fs.readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8');
// 只看**生效的 YAML 结构**：注释里解释"为什么不写"是允许的，
// 真正的风险是有人加了一条 `- id: system-prompt` 或 `system-prompt:` 覆盖键。
check('CO-04', 'bundle 补丁没有生效的 system-prompt / post-execute 条目（普通写作人设与流程不受影响）',
  !/^\s*-\s*id:\s*system-prompt\s*$/m.test(patch) && !/^\s*system-prompt\s*:/m.test(patch) && !/post-execute\s*:/m.test(patch));

// 代码边界：不出现 confirmation ledger 动作
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(js|mjs|yml|json|md)$/.test(entry.name) && !p.includes('test' + path.sep) && !p.includes('scripts' + path.sep)) files.push(p);
  }
})(PLUGIN);
const ledgerPatterns = [/confirmation_resolution\s*\(/, /\bconfirmationLedger\b/, /ledger\.(register|decide|complete)\s*\(/];
const offenders = files.filter((f) => {
  const src = fs.readFileSync(f, 'utf8');
  return ledgerPatterns.some((re) => re.test(src));
});
check('CO-05', '插件不读写 confirmation-resolution 账本（源码级断言）', offenders.length === 0, offenders.map((f) => path.basename(f)).join(','));

// 工具输出里不出现 token
const { redactText } = await import('../lib/redaction.js');
process.env.NOVELSTUDIO_AUDIT_TOKEN = 'TOKENSECRET_'.repeat(5);
check('CO-06', '错误/日志文本会脱敏 token', !redactText('失败：' + process.env.NOVELSTUDIO_AUDIT_TOKEN).includes('TOKENSECRET_'.repeat(5)));
delete process.env.NOVELSTUDIO_AUDIT_TOKEN;

finish('双插件共存');
