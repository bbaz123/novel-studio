/**
 * tests/nsdsh/novel-profile.test.mjs —— S12：小说专用 profile 的组合。
 *
 * S12 动作 3：**移除模型可见的编码人格与无关工具**，且不复制宽权限配置。
 * 这里钉住的是"组合的输入"，而不是"跑起来像不像"：
 *   · patch 层真的声明了禁用项（不是空壳）；
 *   · 编码人格（agent-instructions）与重型通用工具被禁用；
 *   · 禁用清单来自 yml **单一来源**（不手抄，避免与 yml 漂移）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const P = await import('../../harness-plugins/novel-writing/profile.mjs');
const patchPath = path.join(REPO, 'harness-plugins/novel-writing/cordis.patch.yml');
const patchSrc = fs.readFileSync(patchPath, 'utf8');

suite('nsdsh/novel-profile', [
  ['S12-P1 禁用清单来自 patch.yml 单一来源，且数量合理', () => {
    const disabled = P.disabledComponents();
    assert.ok(disabled.length >= 10, `应禁用多项通用能力，实际 ${disabled.length}`);
    // 每一条都必须真的出现在 yml 里（不是 profile.mjs 自己编的）
    for (const id of disabled) {
      assert.ok(patchSrc.includes(id), `禁用的 ${id} 必须在 cordis.patch.yml 里声明`);
    }
    // 反向：yml 里声明 disabled:true 的条数应与解析结果一致（防止解析漏项）
    const declared = [...patchSrc.matchAll(/disabled:\s*true/g)].length;
    assert.equal(disabled.length, declared, `解析出的条数应等于 yml 声明条数（${declared}）`);
  }],

  ['S12-P2 编码人格必须被移除（不注入上游 agent-instructions）', () => {
    const disabled = P.disabledComponents();
    assert.ok(disabled.includes('agent-instructions'), 'S12 动作 3：模型可见的编码人格必须移除');
    // 人设文本不得出现"编码/编程助手"这类定位
    const agentYml = fs.readFileSync(path.join(REPO, 'harness-plugins/novel-writing/agent.cordis.yml'), 'utf8');
    assert.match(agentYml, /小说编辑与执笔者/, '人设应当是小说作者，而不是编码助手');
    assert.ok(!/软件工程师|coding agent|programming assistant/i.test(agentYml), '人设里不得出现编码人格定位');
  }],

  ['S12-P3 与创作无关的重型工具被禁用，但必要的创作与文件能力保留', () => {
    const disabled = new Set(P.disabledComponents());
    for (const must of ['tool-pwsh', 'tool-subagent', 'tool-workflow', 'tool-web', 'tool-skill', 'plan-mode']) {
      assert.ok(disabled.has(must), `${must} 应当被禁用（与小说创作无关或宽权限）`);
    }
    // 保留：通用文件工具（read/write/edit/glob/grep）必须仍可用 —— 它们是写正文的最小必要能力
    assert.deepEqual([...P.GENERIC_TOOLS].sort(), ['edit', 'glob', 'grep', 'read', 'write']);
    for (const t of P.GENERIC_TOOLS) {
      assert.ok(!disabled.has(`tool-${t}`), `${t} 不应被禁用（写正文需要它）`);
    }
  }],

  ['S12-P4 patch 层不得复制宽权限配置：不能出现 disable:false 的静默重启', () => {
    // 我们自己的 patch 里只允许 "disabled: true"，不允许把任何东西 disabled: false
    const falseReenable = [...patchSrc.matchAll(/id:\s*([A-Za-z0-9._-]+)\s*,\s*disabled:\s*false/g)].map((m) => m[1]);
    assert.deepEqual(falseReenable, [], `patch 里不应出现 disabled:false 的重新启用：${falseReenable.join(',')}`);
  }],

  ['S12-P5 能力清单可按分级展开（面板/诊断需要）', () => {
    const m = P.capabilityManifest();
    assert.equal(m.version, P.PROFILE_VERSION);
    const total = m.capabilities.read_only.length + m.capabilities.proposal.length + m.capabilities.author_confirm.length;
    assert.equal(total, P.novelTools().length, '三类之和必须等于小说工具总数');
    assert.ok(m.capabilities.author_confirm.length >= 3, '必须有作者确认类工具');
    assert.ok(m.capabilities.read_only.length > 0 && m.capabilities.proposal.length > 0);
    assert.deepEqual(m.effective_tools, P.effectiveTools());
    assert.ok(Array.isArray(m.disabled_components) && m.disabled_components.length >= 10);
  }],
]);
