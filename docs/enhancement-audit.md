# Novel Studio 增强任务 · 本地代码审计（R01—R12）

> 本文件是 `novel_studio_codex_full_delivery_prompt_v2.md` 任务书的**开工审计**。
> 结论只写两类：**CODE-CONFIRMED**（源码/配置/注册层面确认存在）与 **BLOCKED/缺口**（尚不存在或未运行验证）。
> 运行验证结果在 `docs/enhancement-acceptance.md` 与 `docs/enhancement-progress.json` 里单独记录。
> 审计日期：2026-09-27（本机时间）。

## 0. 基线（开工时）

| 项 | 实际值 | 证据 |
| --- | --- | --- |
| 仓库 | `C:\Users\a1941\Desktop\DeepSeek\novel-studio`（origin `bbaz123/novel-studio`） | `git remote -v` |
| 分支 | `refactor/p0-p6`（相对 origin **ahead 2**） | `git status --branch` |
| HEAD | `be38b17c09f632ee546026fffe2723c5a9b3a18c` | `git rev-parse HEAD` |
| 开工前未提交修改 | **无**（工作区干净） | `git status --porcelain=v2` 0 行 |
| 运行时 | Node **v24.19.0**；`package.json` 无 dependencies；`node_modules/` 仅 pnpm 状态文件 | `package.json`、目录枚举 |
| 技术路线 | Node + SQLite(`node:sqlite`) + Vanilla JS（`public/app.js` 9815 行 / `public/styles.css`） | 代码 |
| DSH | 全局安装 `dsh 0.1.7-rc.2`（`C:\Users\a1941\AppData\Roaming\npm-global`）；`~/.dsh`、`~/.dsh-novel` 均存在 | `dsh --version`、路径探测 |
| OpenViking | `~/.openviking/ovcli.conf`（endpoint `http://localhost:1933`，无 key）＋ `ov.conf`（本地 embedding `bge-small-zh-v1.5-f16`，VLM provider=deepseek）。**只记录来源，不记录 secret 值** | 配置文件读取（脱敏） |
| 离线基线 | `node scripts/ci-offline-checks.mjs` → **32/32 通过**（含 Host Contract 契约测试、前端执行验证、插件工具面核对） | `.verify-enh/ci-offline-baseline.log` |
| 付费模型调用授权 | **无本次显式授权**（用户消息未附预算/次数授权；项目无 live-smoke 预算凭据）。⇒ 一切真实 DeepSeek/OV-VLM 付费调用记 BLOCKED，调用次数 0 | 本文件 §17.4 对应结论 |

本轮**未**执行 `commit / tag / push / merge / rebase`，未触碰用户正式库（自动化使用临时 `NOVELSTUDIO_DATA_DIR`）。

## 1. 分层与边界（CODE-CONFIRMED）

- 宿主：`server.js`（5177 行，HTTP API + 事务 + 作业 + 装配）、`db.js`（650 行，`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` 迁移）、`logger.js`、`harness.js`（930 行，DSH 子进程）。
- 前端：`public/app.js`（9815 行，直连通道 + 全部写作闭环 UI）、`public/index.html`、`public/styles.css`。
- 上下文：`ai/context/layers.mjs`（LAYERS/FLEX_ORDER/TOTAL_BUDGET=settings 19000 / full 26000）、`assembler.mjs`（唯一装配入口，产出 `assembled` + manifest + envelope + integrity）。
- 策略：`ai/policy.mjs`（策略单一来源）；`ai/harness-env.mjs`（子进程环境契约，防回落 3737）。
- 故事状态内核：`ai/story-state/*`（facts/knowledge/timeline/foreshadow/entities/contract/proposal/store/snapshot/rollback，单事务）。
- DSH 插件：`harness-plugins/novel-writing/`（`plugin.json` v0.10.0，23 个工具；`agent.cordis.yml` 人设；`install-profile.mjs`）。
- OV：`openviking.js`（客户端 + 凭证链 + pending 队列）、`openviking-sync.js`（A 链：作品→资源 namespace→检索→宿主层）。
- 契约：`docs/host-contract.md` + `docs/host-contract.v1.json`（**v1.2.0**，`HOST_CONTRACT_VERSION` 在 `server.js:710`）。

## 2. 逐项审计

### R01 DSH 插件加载/安装/能力对账

- CODE-CONFIRMED：bundle 资产齐全（`agent.cordis.yml` / `cordis.patch.yml` / `headless-cordis.patch.yml` / `preset.yml` / `install-profile.mjs` / `test/smoke.mjs`）；`.p1-baseline/verify-plugin-tools.mjs` 通过（工具名↔schema↔manifest↔契约一致）。
- 缺口：**运行期加载**未在本轮验证（需隔离 DSH_HOME + 假模型端点）。项目自带零计费探针 `.p1-baseline/probe-harness-tool-loop.mjs`（真 spawn dsh，假 LLM 端点断言工具循环 ≥2 轮）——本轮用它补齐 RUNTIME-VERIFIED。
- 注意：GUI/headless preset 复制体与源目录的版本/规则 hash 对账需要实测（任务书 §4.2/§4.8）。

### R02 数据与工具边界

**R02.1 非法 action 落入写入 —— 缺口确认（CODE-CONFIRMED）**

- `harness-plugins/novel-writing/novel-tools.mjs` 的 `novel_state_commit`：`action=review` 与 `action=reject` 是两个 `if`，**其余一切值（含拼写错误）继续往下走 apply 分支**。这正是任务书描述的缺陷形状。修复：显式白名单 dispatch。
- 服务端侧对照：`POST /api/novel/proposals/apply|reject`（server.js:4627）由**路径段**决定动作，无自由 action 字段；`POST /api/novel/state/proposals/{review|apply|reject}` 同理。⇒ 真正缺口在插件工具的分发层。

**R02.2 作者批准执行边界 —— 缺口确认（BLOCKED→需实现）**

- `rg 'approv|审批|approval' server.js` **零命中**：全仓不存在宿主侧审批记录机制。
- 现状：`novel_chapter_save`、状态 apply、`/api/novel/proposals/apply`、`/api/novel/state/rollback` 只靠“工具描述里的‘等作者同意’”约束模型，**没有服务端可校验的执行边界**；`approved=true` 这类布尔也没有任何校验点可复用。
- 需要新增：审批记录表（work/chapter/操作类型/基线 hash/提案集合/时间/有效期/单次消费）+ 宿主端点 + 插件工具携带 `approval_id` + 消费在写入事务内原子校验 + 失效条件（已消费/过期/取消/基线变化/切章/换作品）。

**R02.3 补丁安全与 no-op —— 部分存在，需加固（CODE-CONFIRMED）**

- 已有：`parseRevisionPatches`（严格 JSON + 抢救）、`applyRevisionPatches`（逐段精确匹配→包含退让、`used` 防重复、unresolved 必须展示）、`tryApplyRevisionOutput`、空 patches 提示。
- 缺口（对照任务书）：
  1) **无唯一性校验**：同一 anchor 在正文出现两次时，补丁静默命中第一处（需要“恰一处”判定）;
  2) **无重叠/重复 patch 校验**：两条 patch 指向同一段时后者被 `used` 静默跳过（应作为冲突显式报出）;
  3) 生成时未记录正文版本/hash 与稳定段落标识（预览期间原章被改/切章/删章的保护不完整）;
  4) 包含型命中（`paras[i].includes(anchor)`）没有“多段包含”检查。

### R03 正文＋选中提案协同采纳 —— 缺口确认（CODE-CONFIRMED）

- 现状（历史可读路径仍在）：`public/app.js:6411 applySelectedProposals()` 与 `:6848 mergeReviewDiff()` 都是**前端两步 fetch**：先 `/api/novel/chapter_save` 再 `/api/novel/proposals/apply`（或 state proposals apply），没有宿主原子边界。
- 服务端：`chapter_save`（server.js:4808）与 proposals apply 是**两条独立请求、两个事务**；无 idempotency key、无 outbox/pending 投影记录（`notifyChange` 只是 SSE 通知）。
- 需要新增：`POST /api/novel/adopt`（单 SQLite 事务：审批校验→基线校验→旧稿历史+新正文→选中提案（id+version/hash）→审批消费→outbox 投影任务落库→返回），幂等键唯一约束（同 key 同 payload 回放返回原结果；同 key 不同 payload 409），事务外 worker 执行 OV 投影。

### R04 OpenViking 两条链与三类数据边界 —— 部分存在，边界需加固

- CODE-CONFIRMED（A 链）：`openviking-sync.js` 提供 `syncWorkFull` / `removeWorkFromMemory` / `getSemanticRecall` / `semanticSearchMerge` / workDir namespace；`openviking.js` 有凭证解析链、pending 队列（`data/openviking-pending.jsonl` 形状）、`OPENVIKING_PEER_ID` 传递。
- CODE-CONFIRMED（B 链）：`~/.dsh` / `~/.dsh-novel` 存在；DSH 侧 memory bundle 由用户环境安装（本轮只读核验，不改用户全局 profile）。
- 缺口：进入 `assembled` 的 OV 召回**来源校验**需要逐行核对（work_id/scope/canon fail-closed、跨书隔离、未来章节不泄密）；UI 的“投影/检索/待恢复”状态需要核对真实性（不能用 `ov_indexed_at` 有值冒充召回成功）；retry/replay/rebuild 三入口需要核对与补齐。

### R05 最终模型上下文可追踪 —— 部分存在

- 已有：宿主 `assembled` + `context_manifest` + `envelope` + `integrity`（`ai/context/integrity.mjs`），C1/C6 契约有测试。
- 缺口：**DSH 侧后续注入**（persona/工具 schema/OV profile/recall/skill catalog/工具回包）没有“运行时上下文贡献记录”。需要在 harness 请求路径附加来源/规则 hash/长度/计量单位/work/chapter/session/候选状态/去重标识/省略原因；默认日志不得存完整正文/密钥。

### R06 创作上下文改名与首页借鉴页面 —— 缺口确认

- 现状（命中点）：`public/index.html:23`「🤖 AI创造板块」（title 含 SillyTavern）、`public/app.js:410`（HELP_TEXT『SillyTavern 设置』）、`:2136`（菜单 `['st','🧩 SillyTavern 设置']`）、`:3409/:3448/:3453`（renderST 区块与标题）、`README.md:205/239/529/878/901`。
- 缺口：无「借鉴与致谢」首页入口与独立详情视图；无 THIRD-PARTY-NOTICES 的参考项目卡片化记录（现有 THIRD-PARTY-NOTICES.md 仅 2KB）。

### R07 编辑/Humanizer/审稿增强 —— 部分存在

- 已有：`novel_scan` 红线扫描、`novel_style_contract`、`novel_review`（报告落库）、审稿→清单→修稿→差异预览链路、`writing_redlines/style_positive`。
- 缺口：① 三档编辑（轻度润色/去 AI 腔/深度修稿）没有**统一的编辑保护规则资产**与保真校验；② 七项能力（fiction-humanizer / dialogue-editor / webnovel-pacing / mystery-review / romance-review / character-voice / chapter-hook）与题材 profile 不存在；③ “规则实际进入请求/关闭后不进入请求”的验收 fixture 不存在。

### R08 长正文处理 —— 缺陷确认（CODE-CONFIRMED）

- 确认的切片点（目标正文被截断）：
  - `public/app.js:5775` `buildAIPolishMessages` → `${text.slice(0, 6000)}`（润色目标被截断）
  - `public/app.js:5796` `buildAIExpandMessages` → `${text.slice(0, 6000)}`（扩写目标被截断）
  - `public/app.js:6489` 章末质检、`:6510` `buildAIReviewPrompt`、`:6722` `buildAIRevisionPatchPrompt`、`:4908/:4958/:4973`（成文修复/质检）→ `slice(0, 12000)`
  - `public/app.js:7621` 生成上下文 `content.slice(0, 6000)`（需单独判定是否合法上下文裁剪）
- 需要：按“最终序列化请求”实际计量单位判断是否可单请求；超限按稳定段落/场景单元切分（稳定 `segment_id` + `source_version/hash`），target/context-only 分离，分片结果先为候选，全部完成且覆盖清单通过才合并；部分失败只补失败片；陈旧/取消不覆盖。

### R09 作者样文/文风档案/三级作者意图 —— 缺口确认

- 现状：作品/章节 `author_note` 存在并进入上下文（`buildNovelContext`），但**没有**作者样文数据模型、结构化文风档案、三档意图分层（长期方向/阶段重点/本章意图）与冲突呈现。

### R10 契约、知识边界与流程闭环 —— 部分存在（story-state 内核）

- 已有：`chapter_contracts`、`story_facts`（含 `scope/state/status/effective_from`）、`character_knowledge`、preflight/validate/proposals/snapshots 与 UI 读写闭环（v1.1/v1.2 契约）。
- 缺口：按“当前章/场景”的**读者已披露**派生视图与失效重算（章节重排/插入早期章/回滚/retcon 后必须失效）；AUTHOR/CANON/CHARACTER 三层的 UI 呈现与测试。

### R11 剧情分支沙盘 —— 缺口确认

- 现状：`story_state_proposals` 有 `event/foreshadow/...` 种类，无“2—5 个候选方向/比较/采用/丢弃/stale”的候选蓝图体系与 UI。

### R12 导入后的 AI 状态重建 —— 部分存在

- CODE-CONFIRMED 已有：TXT/Markdown 文本导入 + EPUB（`server.js:2748 parseEpub`，零依赖 `zip-reader.mjs`）；`splitTextIntoCapters` 拆章；导入上限 24MB（EPUB）/32MB body。
- `zip-reader.mjs` 已有单条目 128MB / 总量 256MB 解压上限，但**没有条目路径校验**（`../`、绝对路径只被忽略写入、当前不解压到磁盘所以暴露面小，仍需按任务书显式安全失败）。
- 缺口：可选“分析并重建创作状态”流程（分批抽取、实体合并候选、断点续跑、批次基线 hash、确认后原子应用）不存在。

## 3. 任务书 §18 负向/回归用例覆盖现状（开工时）

已有基线覆盖：非法 action/越权（部分）、迁移兼容（部分）、上下文逐字节（有 `capture-baseline/compare-baseline`）、日志脱敏（有 `audit-llm-calls` 自检）、注入类（部分）。
本轮需新增：审批失效矩阵、补丁唯一性/重叠/空补丁、正文事务中途失败回滚、幂等键冲突、OV 失败 pending 恢复、跨书隔离、未来章泄密、导入 zip 安全等（见验收矩阵测试 ID）。

## 4. 结论

- **可直接复用**：上下文装配/manifest/查回、story-state 事务内核、提案/快照/回滚、作业设施、策略表、同步门闸、离线测试设施、隔离实例封装（`scripts/ci-isolated-run.mjs`）。
- **真实缺口（本轮实现重点）**：R02 全部、R03、R08、R05、R06、R07 规则化、R04 来源校验、R09、R10 披露派生、R11、R12 分析重建。
- **外部依赖风险**：真实 DSH 加载可用本机 dsh 0.1.7-rc.2 + 假模型端点零计费验证；真实 OV 服务端（localhost:1933）是否运行需实测；付费 DeepSeek/OV-VLM 调用无授权 ⇒ BLOCKED。

---

## 附录 A（2026-09-27 收尾补记）：修复前后差异

> 本文件 §0—§4 是**开工时的审计快照**，保留原样不改写（文中 "v0.10.0 / 契约 v1.2.0 / 32 条离线检查" 是开工时的事实）。
> 下面是收尾时对该快照的逐项对照；验收结论与证据见 `docs/enhancement-acceptance.md` 与 `docs/enhancement-progress.json`。

| 快照里的说法（开工时） | 收尾时的实际值 | 证据 |
| --- | --- | --- |
| DSH 插件 v0.10.0，23 个工具 | **v0.14.0，25 个工具 / 68 条端点**（plugin.json / package.json / novel-tools.mjs 三处一致） | `node .p1-baseline/verify-plugin-tools.mjs` |
| Host Contract v1.2.0 | **1.10.0**（附加式历史 1.3.0—1.10.0；46 张表 / 68 端点 / 25 工具；`contract_history` 11 条） | `docs/host-contract.v1.json`、`node .p1-baseline/test-host-contract.mjs`（28/0） |
| 离线基线 32/32 | **45/45**（新增 13 条：隔离实例、负向对照与迁移幂等；全部零计费） | `.verify-enh/ci-offline-final.log` |
| R02 缺口：非法 action / 审批 / 补丁 | 全部补齐：白名单 dispatch 24/0、审批边界 50/0、补丁硬化 `frontend-test` 89/90b/90c/107i | 见验收报告 §2 与 `.verify-enh/boundary.log`、`.verify-enh/approval-boundary-run2.log` |
| R03 缺口：无原子采纳 | `POST /api/novel/adopt` 单事务 + 幂等键 + outbox；36/0 | `.verify-enh/adopt-atomic-run2.log` |
| R04 缺口：无来源校验 | fail-closed 四判据 + 范围证明 + `ov_projection_audit`；38/0 | `.verify-enh/ov-recall-boundary.log` |
| R05 缺口：无可追踪贡献 | contributions 只读端点（已进契约声明面）+ 27/0 | `.verify-enh/context-contributions.log` |
| R06 缺口：SillyTavern 命名与致谢页 | 用户面统一「创作上下文」（保留兼容 alias）+ 首页致谢页；58a—58g | `.verify-enh/frontend-run7.log` |
| R07 / R08 / R09 / R10 / R11 / R12 缺口 | 全部实现并离线验收（45/0、58/0、52/0、31/0、66/0、30+28+13/0） | 见验收报告 §2 |
| 迁移兼容"部分覆盖" | 空库 / 重复启动 / 损坏库负向对照补齐（13/0）；旧库只读指纹仍 `3cb7e5d9ac4f67b9` | `.verify-enh/migration-idempotent.log` |
| 快照里"注入类（部分）" | 结论不变：链路防线（写入/审批/导入剥标签/召回 fail-closed）有测试，**没有**专用 prompt injection 红队用例 ⇒ SKIP（不伪造） | 验收报告 §6.4 |
| 外部依赖风险（真实 OV / 付费调用） | **当晚更新**：付费调用已按用户授权「预算2元以内」执行（8 次调用 ≈¥0.035：能力探针 7/0 + 整链冒烟 7/0，见验收报告 §6.2）；真实 OV 维持 BLOCKED（1933 未监听） | `.verify-enh/live-capabilities-2026-09-27.{log,json}`、`.verify-enh/smoke-chain-2026-09-27.{log,usage.json}`、`.verify-enh/ov-port-probe-run2.log` |
| 真实 DSH 工具循环 | 两层证据：零计费假端点 **7/0** ＋ 真实模型整链写作冒烟 **7/0** | `.verify-enh/r01-harness-tool-loop-run2.log`、`.verify-enh/smoke-chain-2026-09-27.log` |
