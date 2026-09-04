# 工坊内置插件扩展指南

本文说明如何在 **novel-studio 仓库内部**扩展本插件。定位：本插件是工坊的内置组件，
**不独立打包、不独立发布**——dsh 侧代码与工坊服务端同仓维护（见同目录 ENGINE.md / README.md）。

## 插件文件契约（novel-tools.mjs）

本插件就是一个符合 dsh 插件加载器约定的 ESM 模块，**纯 JavaScript、无构建步骤**：

```js
export const name = 'novel-tools'        // 插件名（行 id 用）
export const inject = ['tools']          // 依赖 dsh 的 tools 注册表服务
export const PLUGIN_VERSION = '0.4.0'    // 与 plugin.json 的 version 保持一致

export function apply(ctx, config) {
  // config 来自行配置（agent.cordis.yml / headless patch 里的 config 字段）
  // ctx.tools.register({ name, description, parameters, output, execute }) 注册模型工具
}
```

工具注册采用当前实测可用的契约 `ctx.tools.register`，输出统一走 textOutput 包装
（见 `novel-tools.mjs` 顶部），不要使用已过时示例里的 `ctx.tools.set` / `defineTool`。

## 增加一个新工具的步骤（例：novel_timeline）

1. **服务端**（`server.js`）加端点：如 `GET /api/novel/timeline?work_id=`，返回装配好的时间线文本；
   涉及新数据则在 `db.js` 加表/列（旧库用 try-ALTER 兼容）。
2. **dsh 侧**（`novel-tools.mjs`）`register('novel_timeline', 描述, 参数schema, execute)`：
   - 描述里写明“什么时候调用、返回什么、注意什么”；
   - 参数里 work_id/chapter_id 用 `envId(args, key)` 兜底环境身份；
   - 用 `jfetch` 调服务端（严格 JSON、可读错误、超时）；
   - 需要“只读给作者看”的工具返回人话文本；需要“写账本”的工具遵循提案模式
     （`proposeMode()` 为 true 时传 `proposed: true`）。
3. **人设**（`agent.cordis.yml` 与 `headless-cordis.patch.yml`）：在创作纪律里补一句该工具的使用时机，
   两个文件的人设保持同一纪律文本。
4. **清单与文档**：`plugin.json` 的 tools/engineEndpoints 补一行；README 工具表补一行；本文档验收步骤补断言。
5. **测试**：在 `test/smoke.mjs` 里对新端点补一段断言。
6. **发布**：本仓库 `git commit` 后，重跑 `install.ps1`（区块合并升级，自动同步 ~/.dsh 两处安装点）。

## 改动注意

- **唯一来源**：dsh 侧工具/人设只维护本目录一份；安装是“复制”，不是“分发”。
  不要直接手改 `~/.dsh` 里的副本，否则下次安装会覆盖。
- **提案模式**：写账本类工具必须遵循 `NOVELSTUDIO_PROPOSE_MODE`（headless 先提案、作者确认后入账），
  否则 headless 任务会绕过作者直接污染作品账本。
- **红线扫描**：新模式必须通过 `replaceRedlines` 的校验（kind 白名单 / 长度 ≤500 / regex 可编译）；
  病态正则会拖慢每次扫描。
- **安全**：新端点若是写操作，走 `handleAPI` 顶部的 `isLocalRequest` 统一防护；
  读端点注意不要泄露 `api_configs.api_key` 等敏感字段。
- **上下文预算**：`buildNovelContext` 的分层预算表在 server.js 内，新层加入时给它一个上限，
  并确认总预算收敛逻辑（TOTAL_BUDGET/FLEX_ORDER）仍把红线层放在保底位。

## 版本

- `plugin.json.version` 与 `novel-tools.mjs` 的 `PLUGIN_VERSION` 必须同步；
- 升级路径：改仓库 → `node test/smoke.mjs` → `install.ps1` → 重启 novel-studio。
