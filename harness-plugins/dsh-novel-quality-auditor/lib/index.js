/**
 * dsh-novel-quality-auditor —— 包入口（DSH bundle 的 plugin 入口）。
 *
 * 四个工具：open / read / submit / status。
 * 它们只做"受约束的数据交换与提交"，不是编辑器：
 *   · 不直接改正文；
 *   · 不读写 dsh-confirmation-resolution 的 C 编号账本；
 *   · 没有 active audit 环境时一律返回 NOT_APPLICABLE（普通写作任务不受影响）。
 *
 * 工具名统一 `novel_quality_*`，与 novel-writing 的 `novel_*` 不冲突（PL-11）。
 */
import { normalizeConfig } from './config.js';
import { readEnv } from './env.js';
import { createClient } from './http-client.js';
import { createIdempotencyStore } from './idempotency.js';
import { registerTurnGuard } from './turn-guard.js';
import { safeErrorPayload } from './redaction.js';
import { POLICY_SECTION_ID } from './prompt-policy.js';
import { openTool } from './tools/open.js';
import { readTool } from './tools/read.js';
import { submitTool } from './tools/submit.js';
import { statusTool } from './tools/status.js';

export const name = 'novel-quality-auditor';
export const inject = ['tools'];
export const PLUGIN_VERSION = '0.1.0';
export const TOOL_NAMES = Object.freeze([
  'novel_quality_open', 'novel_quality_read', 'novel_quality_submit', 'novel_quality_status',
]);

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const env = readEnv();
  // 优先级：任务注入的 NOVELSTUDIO_BASE_URL → 安装期 config.baseUrl → 默认 3737。
  // 顺序反了会让隔离实例的审计回落到主实例（novel-tools 踩过同一个坑）。
  const client = createClient({ baseUrl: env.baseUrl || cfg.baseUrl, token: env.auditToken });
  const state = {
    blindSubmitted: false, finalSubmitted: false, reminderCount: 0, terminal: false, failed: false,
  };
  const idempotency = createIdempotencyStore();
  const tools = [
    openTool({ client, env }),
    readTool({ client, env }),
    submitTool({ client, env, state, idempotency }),
    statusTool({ client, env, state }),
  ];
  for (const tool of tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties: tool.parameters || {}, additionalProperties: false },
      output: textOutput,
      async execute(args) {
        // 工具层错误统一转成结构化文本：模型需要看到 code（决定要不要重试），
        // 但不该看到堆栈或正文。审计失败是**预期内**的结果，不是插件故障。
        try {
          return { text: await tool.execute(args || {}) };
        } catch (e) {
          return { text: JSON.stringify({ ok: false, ...safeErrorPayload(e) }) };
        }
      },
    });
  }
  const guard = registerTurnGuard(ctx, { env, state });
  return {
    name,
    version: PLUGIN_VERSION,
    policy_section: POLICY_SECTION_ID,
    tools: tools.map((t) => t.name),
    turn_guard: guard,
    active_audit: Boolean(env.active),
  };
}

export default { name, inject, apply, PLUGIN_VERSION, TOOL_NAMES };
