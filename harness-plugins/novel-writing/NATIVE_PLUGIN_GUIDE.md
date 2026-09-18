# 工坊内置插件扩展指南

本文说明如何在 **novel-studio 仓库内部**扩展本插件。定位：本插件是工坊的内置组件，
**不独立打包、不独立发布**——dsh 侧代码与工坊服务端同仓维护（见同目录 ENGINE.md / README.md）。

## 插件文件契约（novel-tools.mjs）

本插件就是一个符合 dsh 插件加载器约定的 ESM 模块，**纯 JavaScript、无构建步骤**：

```js
export const name = 'novel-tools'        // 插件名（行 id 用）
export const inject = ['tools']          // 依赖 dsh 的 tools 注册表服务
export const PLUGIN_VERSION = '0.9.0'    // 与 plugin.json 的 version 保持一致（plugin.json 是真源）

export function apply(ctx, config) {
  // config 来自行配置（agent.cordis.yml / cordis.patch.yml 里的 config 字段）
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
3. **人设**（`agent.cordis.yml` 与 `cordis.patch.yml`）：在创作纪律里补一句该工具的使用时机，
   两个文件的人设保持同一纪律文本。
4. **清单与文档**：`plugin.json` 的 `tools` 补一行；README 工具表补一行；本文档验收步骤补断言。
   端点若被工具**真正调用**，同步补进 `plugin.json` 的 `engineEndpoints`——`verify-plugin-tools.mjs`
   会做「代码调用了但清单没声明」的对账，那才是真漂移方向（反向的"声明了但没调用"是正常的：
   清单也收录前端/其它调用方用的引擎端点）。
5. **版本**：`plugin.json.version` 是唯一真源。改完把 `package.json` 与 `novel-tools.mjs` 的
   `PLUGIN_VERSION` 一起升——三处不一致会被 `verify-plugin-tools.mjs` 判失败。
6. **测试**：在 `test/smoke.mjs` 里对新端点补一段断言（它自起隔离服务 + 临时库，
   零成本、不碰真实数据、不需要 dsh 或 API Key）。
7. **发布**：本仓库 `git commit`。bundle 走 junction 引用本目录，**仓库改动立即生效**（无复制步骤），
   重启 novel-studio 即可；只有**新增 profile**或**迁移旧安装**时才需要跑 `install.ps1`。
   ⚠️ 但 **GUI preset 那份是副本**（`~/.dsh/.agent-presets/novel-writing/`）：改了 `agent.cordis.yml`
   或 `novel-tools.mjs`、想让 **GUI 交互会话**也用上，必须重跑一次 `install.ps1`。

## 改动注意

- **唯一来源**：dsh 侧工具/人设只维护本目录一份。profile 通过 junction 直接引用本目录，
  因此不存在“需要同步的副本”；也**不要**手工往 `~/.dsh` 里放第二份，那会与 bundle 抢同一个行 id。
- **提案模式**：写账本类工具必须遵循 `NOVELSTUDIO_PROPOSE_MODE`（headless 先提案、作者确认后入账），
  否则 headless 任务会绕过作者直接污染作品账本。
- **红线扫描**：新模式必须通过 `replaceRedlines` 的校验（kind 白名单 / 长度 ≤500 / regex 可编译）；
  病态正则会拖慢每次扫描。
- **安全**：新端点若是写操作，走 `handleAPI` 顶部的 `isLocalRequest` 统一防护；
  读端点注意不要泄露 `api_configs.api_key` 等敏感字段。
- **上下文预算**：⚠️ P1–P2 重构后层规格**已不在 server.js 里**——唯一真源是
  `ai/context/layers.mjs` 的 `LAYERS`（每层的 cap / kind / 收缩属性）与 `RETRIEVAL`（查回路径）。
  新层加在那里，**并且必须同时声明查回路径**（不变量 I4：做不到查回的层**不允许裁剪**），
  否则 `.p1-baseline/verify-retrieval.mjs` 会报缺口。总预算与**可执行下限由 `computeFloor()` 自动核算**，
  不要手写常量——历史失误：settings 预算曾设成 12,000，而各层 cap 之和已超过它，**收敛永远压不到**。
  改完必须重抓基线对照（`capture-baseline.mjs` → `compare-baseline.mjs`），任何差异都要能解释。

## 版本

- `plugin.json.version` 是版本真源，`novel-tools.mjs` 的 `PLUGIN_VERSION` 与
  `package.json`（bundle 包）的 `version` 都必须与它同步；
- 升级路径：改仓库 → `node test/smoke.mjs` → 重启 novel-studio。
  （bundle 走 junction，无需重跑 `install.ps1`；仅在新增 profile 或迁移旧安装时才需要。）
