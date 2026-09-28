# Novel Studio 增强任务 · 验收报告（R01—R12）

> 任务书：`novel_studio_codex_full_delivery_prompt_v2.md`（R01—R12 增强交付）。
> 验收日期：2026-09-27（本机）。仓库 `C:\Users\a1941\Desktop\DeepSeek\novel-studio`，分支 `refactor/p0-p6`，
> HEAD `be38b17c09f632ee546026fffe2723c5a9b3a18c`（任务期间**未 commit / 未 tag / 未 push**；全部改动留在工作区）。
> 开工时工作区干净；本报告只记录**本次任务实际产生并落盘**的证据。
>
> **判定口径**：状态只有 `PASS / FAIL / BLOCKED / SKIP` 四种；证据等级只有 `CODE-CONFIRMED`（源码/配置/静态核对，
> 或在不具备运行条件的路径上只做了代码级确认）与 `RUNTIME-VERIFIED`（在真实 Node/HTTP/SQLite 运行路径上跑过：
> 隔离实例、真 spawn dsh、真读写临时库）。vm+DOM 桩的前端执行验证归 `CODE-CONFIRMED`（执行了真实前端代码，但不是真实浏览器）。
> 真实付费模型 / 真实 OV 服务 / 真实浏览器三类验收，无本次授权或环境不可用 ⇒ 一律 `BLOCKED`，绝不写 PASS。
>
> 本次**已获用户显式预算授权**（2026-09-27「给予预算2元以内」），付费实机验收在**预先记录硬上限**后执行（见 §6.2）。
>
> **本次付费模型调用：8 次**（能力探针 7 次 + 整链写作冒烟 1 次；8 项全通过；保守估算合计 ≈ **¥0.035** ≤ 授权 ¥2）。
> CI/离线测试全程零计费；真实 OV 与真实浏览器仍 `BLOCKED`（§6.3）。

## 0. 结论速览

| 维度 | 结论 | 状态 | 证据 |
| --- | --- | --- | --- |
| 离线零计费总闸（45 条检查） | 45 通过 / 0 未通过（实机验收后交付前复跑仍 45/0） | PASS | `.verify-enh/ci-offline-final.log`、`.verify-enh/ci-offline-postlive.log` |
| 前端执行验证（vm + DOM 桩，260 条断言） | 全部通过 | PASS | `.verify-enh/frontend-run7.log` |
| Host Contract 契约测试 | 28 通过 / 0 失败（契约 1.10.0） | PASS | `node .p1-baseline/test-host-contract.mjs` |
| 插件工具面/版本/端点对账 | 25 工具 / 68 端点 / v0.14.0 三者一致 | PASS | `node .p1-baseline/verify-plugin-tools.mjs` |
| 隔离实例全量验收（verify-all） | 48 通过 / 1 未通过 / 6 跳过（唯一未通过 = 先于本任务的连续性真实数据对照，见 §6.1） | 见 §6 | `.verify-enh/verify-all-final2.log` |
| R01 真实 DSH 工具循环（自设假模型端点，零计费） | 7 通过 / 0 失败：模型→工具→模型真的跑通 | PASS（RUNTIME-VERIFIED） | `.verify-enh/r01-harness-tool-loop-run2.log` |
| 真实 DeepSeek 能力探针（编辑/审稿/样文/推演/契约/抽取 6 类，7 次调用） | 7 通过 / 0 失败；2226 tokens；保守估算 ≈¥0.013 | PASS（RUNTIME-VERIFIED） | `.verify-enh/live-capabilities-2026-09-27.{log,json}` |
| 真实写作整链冒烟（真 dsh + 真 DeepSeek + 临时作品，1 次调用） | 7 通过 / 0 失败；10591 tokens；≈¥0.022；临时作品已删 | PASS（RUNTIME-VERIFIED） | `.verify-enh/smoke-chain-2026-09-27.{log,usage.json}` |
| 真实 OpenViking 双闭环（作品资源链 + 会话链） | 本机 1933 端口未监听（当晚复测仍未监听），且写入型 live 需专用 namespace 授权 | BLOCKED | `.verify-enh/ov-port-probe-run2.log` |
| 真实浏览器 E2E（首页/致谢/创作/编辑/审稿/分支/导入/重启恢复） | 环境无浏览器驱动 | BLOCKED | §6.3 |
| 任务书 §18 负向用例 | 20/20 项有测试 ID 与命中记录（1 项部分覆盖，见 §3） | PASS | §3 |

**一句话**：R01—R12 的代码、离线测试与文档全部交付；离线可自动验证的部分全部通过；本次在用户授权预算内补做了
**真实 DeepSeek 实机验收**（六类能力探针 7/0 + 真实写作整链冒烟 7/0，合计 8 次调用 ≈¥0.035，见 §6.2），
真实 OV（服务未监听）与真实浏览器（无驱动）如实记 `BLOCKED`；另有 1 条**先于本任务就存在**的真实数据验收
（连续性预检在作者真实作品上命中 4/5）保持 `FAIL`，归因见 §6.1。

## 1. R01—R12 逐项状态与证据

| 项 | 交付内容 | 状态 | 证据等级 | 关键命令 | 证据文件 | 计数 |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | DSH 插件加载/安装/能力对账：bundle 版本 0.14.0（三处一致）、25 工具 / 68 端点、Host Contract 1.10.0 | PASS（真实模型闭环已补验，见 §6.2） | RUNTIME-VERIFIED | `node .p1-baseline/probe-harness-tool-loop.mjs`；`node .p1-baseline/verify-plugin-tools.mjs`；`node .p1-baseline/test-host-contract.mjs` | `.verify-enh/r01-harness-tool-loop-run2.log`、`.verify-enh/smoke-chain-2026-09-27.log` | 7/0；25/68；28/0；冒烟 7/0 |
| R02 | 非法 action 白名单分发 + 宿主审批执行边界 + 补丁唯一性/重叠/空补丁硬化 | PASS | RUNTIME-VERIFIED | `node .p1-baseline/test-agent-write-boundary.mjs`；`node .p1-baseline/test-approval-boundary.mjs`；`node frontend-test.mjs` | `.verify-enh/boundary.log`、`.verify-enh/approval-boundary-run2.log` | 24/0；50/0；前端 89/90b/90c/107i |
| R03 | 正文＋选中提案原子采纳（单事务 / 幂等键 / outbox 可恢复） | PASS | RUNTIME-VERIFIED | `node .p1-baseline/test-adopt-atomic.mjs` | `.verify-enh/adopt-atomic-run2.log` | 36/0 |
| R04 | OV 两条接入链 + 召回来源 fail-closed（跨书/未来章/候选/布局不明）与范围证明 | PASS（真实 OV 闭环 BLOCKED） | RUNTIME-VERIFIED | `node .p1-baseline/test-ov-recall-boundary.mjs` | `.verify-enh/ov-recall-boundary.log`、`docs/openviking-call-map.md` | 38/0 |
| R05 | 运行时上下文贡献记录（来源/hash/长度/去重/省略原因，只读端点） | PASS | RUNTIME-VERIFIED | `node .p1-baseline/test-context-contributions.mjs` | `.verify-enh/context-contributions.log` | 27/0 |
| R06 | 用户面改名「创作上下文」（兼容 alias）+ 首页「借鉴与致谢」页 | PASS（真实浏览器 BLOCKED） | CODE-CONFIRMED | `node frontend-test.mjs` | `.verify-enh/frontend-run7.log` | 58a—58g |
| R07 | 编辑保护规则（三档编辑 / 七项能力 / 题材档），规则真的进请求 | PASS（真实模型语义已补验，见 §6.2） | RUNTIME-VERIFIED | `node .p1-baseline/test-editing-rules.mjs`；`node .p1-baseline/probe-live-capabilities.mjs` | `.verify-enh/editing-rules.log`、`.verify-enh/live-capabilities-2026-09-27.json` | 45/0；探针 edit_deai / review_semantic 通过 |
| R08 | 完整长正文处理（去切片 / 分段 / 覆盖清单 / 断点续跑 / 取消） | PASS | RUNTIME-VERIFIED | `node .p1-baseline/test-long-text.mjs` | `.verify-enh/long-text.log` | 58/0 |
| R09 | 作者样文 / 结构化文风档案 / 三级作者意图（样文不进事实） | PASS（真实模型语义已补验，见 §6.2） | RUNTIME-VERIFIED | `node .p1-baseline/test-author-style.mjs`；`node .p1-baseline/probe-live-capabilities.mjs` | `.verify-enh/author-style.log`、`.verify-enh/live-capabilities-2026-09-27.json` | 52/0；探针 style_profile 通过 |
| R10 | 披露派生视图（作者真相 / 读者披露 / 角色掌握三视图，按时点重算） | PASS | RUNTIME-VERIFIED | `node .p1-baseline/test-disclosure.mjs` | `.verify-enh/r12-suite-counts.log` | 31/0 |
| R11 | 剧情分支沙盘（2—5 候选 / 比较 / 采纳只写蓝图 / stale 强制复核） | PASS（真实推演已补验，见 §6.2） | RUNTIME-VERIFIED | `node .p1-baseline/test-branch-sandbox.mjs`；`node .p1-baseline/probe-live-capabilities.mjs` | `.verify-enh/r12-suite-counts.log`、`.verify-enh/live-capabilities-2026-09-27.json` | 66/0；探针 branch_deduction 通过 |
| R12 | 导入安全（zip 路径/符号链接/压缩比/大小/编码）＋导入后 AI 状态重建（分批/断点/按批原子）＋迁移幂等 | PASS（真实模型抽取已补验，见 §6.2） | RUNTIME-VERIFIED | `node .p1-baseline/test-import-guard.mjs`；`node .p1-baseline/test-import-rebuild.mjs`；`node .p1-baseline/test-migration-idempotent.mjs` | `.verify-enh/ci-offline-final.log`、`.verify-enh/migration-idempotent.log`、`.verify-enh/live-capabilities-2026-09-27.json` | 30/0；28/0；13/0；探针 import_extract 通过 |
## 2. 分项证据（R01—R12）

### R01 DSH 插件实际加载、安装与能力对账 —— PASS（真实模型闭环已补验）

- **改了哪些文件**：`harness-plugins/novel-writing/plugin.json`（0.13.0 → **0.14.0**，`engineEndpoints` 61 → **68**）、
  `harness-plugins/novel-writing/package.json`（同版本）、`harness-plugins/novel-writing/novel-tools.mjs`（`PLUGIN_VERSION = '0.14.0'`）、
  `docs/host-contract.md` / `docs/host-contract.v1.json`（1.9.0 → **1.10.0**：46 张表 / 68 条端点 / 25 个工具）、
  `server.js`（`HOST_CONTRACT_VERSION = '1.10.0'`）、`scripts/ci-offline-checks.mjs`（检查清单 32 → **45** 条）。
- **运行期加载（真的起 dsh）**：`.p1-baseline/probe-harness-tool-loop.mjs` **真 spawn 隔离后的 DSH**（专用 `DSH_HOME`），
  自设**本地假模型端点**（`http://127.0.0.1:2611`，零计费、封闭外部 Provider），断言「模型 → 工具（glob）→ 模型」两轮循环真的跑通：
  端点收到 2 条请求、第一轮是工具轮、第二轮带回工具结果、工具结果里出现了被请求的文件、任务正常收尾。**7 通过 / 0 失败**（8.5s）。
  证据：`.verify-enh/r01-harness-tool-loop-run2.log`。
- **安装一致性（只读核验，未改用户全局 profile）**：`~/.dsh-novel/profiles/novel/node_modules/novel-writing` 是指向仓库的
  **Junction（链接，不是拷贝）**，因此安装位读取到的 manifest 与仓库同源：**0.14.0 / 25 工具 / 68 端点**。
  GUI 与 headless 两种 preset 的复制体与源目录版本/hash 对账由 `.p1-baseline/verify-plugin-tools.mjs` 覆盖（通过）。
- **复用 vs 补齐**：bundle 资产（`agent.cordis.yml` / preset / `install-profile.mjs` / `smoke.mjs`）是既有能力，未重写；
  本轮补的是**端点声明面**（R05 的 contributions 端点此前已实现但未声明）与**契约版本/历史记录**的同步。
- **已补验（有限预算）**：真实付费模型驱动的写作闭环已由 §6.2 的整链冒烟覆盖（真 dsh → 真 DeepSeek → 临时作品，7/0）；
  「模型→工具→模型」的形态断言仍由零计费假端点探针覆盖（`probe-harness-tool-loop.mjs`）。

### R02 非法 action / 作者批准 / 补丁安全 —— PASS

- **R02.1 非法 action 不落入写入**：`harness-plugins/novel-writing/novel-tools.mjs` 的 `novel_state_commit` 改为
  **显式白名单 dispatch**（review / reject / apply 之外的一切值——含拼写错误与未知动作——一律拒绝，不再继续走到写入分支）。
  证据：`.p1-baseline/test-agent-write-boundary.mjs` **24 通过 / 0 失败**（含阴性对照：把分发改回旧行为必须判红）。
- **R02.2 作者批准是执行边界**：新增 `author_approvals` 表 + `GET/POST /api/novel/approvals` + `novel_approvals` 插件工具；
  审批在**写入事务内**单次消费，失效矩阵（已消费 / 过期 / 撤销 / 基线 hash 变化 / 切章 / 换作品 / 跨作品）全部拒绝写入。
  证据：`.p1-baseline/test-approval-boundary.mjs`（隔离实例 + 隔离临时库）**50 通过 / 0 失败**。
- **R02.3 补丁安全**：唯一性（同一 anchor 必须恰一处命中）、重叠/重复 patch（显式冲突，不再静默跳过）、空 patches（合法 no-op）、非法 JSON（拒绝）。
  证据：`frontend-test.mjs` 断言 89（空补丁 = 合法 no-op）、90b/90c（anchor 非唯一 / 重叠显式失败）、107i（补丁基于目标章正文）。
- **BLOCKED**：无（全部可在离线隔离实例上验证）。

### R03 正文＋选中提案协同采纳 —— PASS

- `POST /api/novel/adopt`：审批校验 → 基线校验 → 旧稿存历史版本 → 新正文 → 选中提案（含 id/version/hash）→ 审批消费 →
  `projection_outbox` 落库，**同一 SQLite 事务**；`adoption_operations` 幂等键（同键同载荷回放返回原结果、同键不同载荷 409）；
  事务外 worker 执行 OV 投影，失败可见、可重试、重启后只凭 outbox 续跑。
- 同轮修复两个实测缺陷：旧提案采纳路径因嵌套 `BEGIN` **必然报 "cannot start a transaction within a transaction"**（改为
  SAVEPOINT 深度感知事务原语，落在 `db.js`）；单 id 静默无操作。
- 证据：`.p1-baseline/test-adopt-atomic.mjs` **36 通过 / 0 失败**（含事务中间注入 SQLite 失败 → 正文/历史/提案/状态一起回滚；
  提交成功但 OV 失败 → 正文保留、投影待恢复；重启续跑 attempts 递增）。

### R04 OpenViking 两条接入链与三类数据边界 —— PASS（真实 OV 闭环 BLOCKED）

- 调用图落盘在 `docs/openviking-call-map.md`（A 链：作品→资源 namespace→检索→宿主层；B 链：会话采集→服务端→新会话召回）。
- 新增 `ai/openviking/recall-meta.mjs`：召回来源 **fail-closed 四道判据**（namespace / 布局已知 / 正典状态 / 未来章节），
  宿主装配器与召回生产方**共用同一实现**；`ov_projection_audit` 表 + 作者侧 `POST /api/novel/projections/replay|rebuild`、
  `GET /api/novel/projections/audit`（rebuild 默认 dry-run、删除前逐条证明归属，证明不了拒绝执行；模型侧 403）。
- 证据：`.p1-baseline/test-ov-recall-boundary.mjs`（隔离实例 + 本地 OV stub）**38 通过 / 0 失败**：
  跨书串扰、未来章提前泄密、未采纳候选被当成本书事实、rebuild 范围证明失败 → 拒绝执行且零删除、replay 投影可查询。
- **复用 vs 补齐**：既有 `openviking.js` 凭证链与 pending 队列、`openviking-sync.js` 同步链未重写；补的是**来源判据与范围证明**。
- **BLOCKED**：真实 OV 服务双闭环。依据：本机 `127.0.0.1:1933` 未监听（`.verify-enh/ov-port-probe.log`，TCP 探测）；
  写入型 live 测试需要带测试标识的专用 account/peer/work/session/resource namespace，当前 OV 版本无法证明足够隔离；
  且真实链路若触发付费 VLM/embedding 亦无本次授权。

### R05 最终模型上下文可追踪 —— PASS

- 新增 `ai/context/contributions.mjs` + `GET /api/novel/context/contributions?work_id=&chapter_id=`（**只读**）：
  逐条记录进入最终请求的来源 id / 版本 hash / 长度 / 去重标识 / 使用或省略原因；**不记完整正文，也不记密钥**。
  该端点本轮补进契约声明面（68 条端点之一）；默认 `dedup_action:'off'`，默认行为与接入前一致。
- 证据：`.p1-baseline/test-context-contributions.mjs`（隔离实例 + OV stub）**27 通过 / 0 失败**：
  结构可审计、来源感知去重、默认行为不变、脱敏检查。

### R06 创作上下文改名与首页借鉴页面 —— PASS（真实浏览器 BLOCKED）

- 用户面统一叫「创作上下文」：`public/app.js` 的 `HELP_TEXT.sillytavern.title='创作上下文'` 且新增兼容 alias
  `HELP_TEXT.creation_context`；旧内部键 `sillytavern` / 视图 `st` / `renderST` **保留**（旧会话、旧 localStorage、旧帮助锚点不失效）；
  历史来源在正文里如实说明（不假装它从没叫过 SillyTavern）。
- 首页新增「🙏 借鉴与致谢」视图（`public/index.html` + `renderThanks`）：三类关系（实际运行组件 / 设计·方法参考 / 实际引入的代码·规则·资产）、
  每张外链卡 `target="_blank" rel="noopener noreferrer"`、不显示 stars、不暗示官方合作/背书、参考项目带核验日期与 `仓库@commit` 与 LICENSE。
  记录同步进 `THIRD-PARTY-NOTICES.md`（SillyTavern @06bde939fb1e / Humanizer @9862685f575c / InkOS @8fc2ae57080b /
  webnovel-writer @54513e3e1ac7 / Oh Story @4a50d5583590，核验 2026-09-27）。
- 文档同步：`README.md`、`docs/新手入门.md`（"旧称 SillyTavern 设置，只是历史叫法"）。
- 证据：`frontend-test.mjs` 断言 **58a—58g**（`.verify-enh/frontend-run7.log`，整体 ALL PASS / 260 断言）。
- **BLOCKED**：真实浏览器里点击「借鉴与致谢」页（§17.2）——环境无浏览器驱动，见 §6.3。
### R07 小说编辑、Humanizer 与审稿增强 —— PASS（真实模型语义已补验）

- 新增 `ai/editing/rules.mjs`（编辑保护规则资产，三档共用；`EDITING_RULE_VERSION 1.0.0`）与 `ai/editing/scan.mjs`
  （**确定性**扫描：规则 / 位置 / 摘录 / 严重性 / 建议，不调用模型）。
- 新增门控上下文层 `edit_rules`（默认关闭：关闭时该层不存在，`assembled`/manifest 与接入前逐字节一致；打开后规则块
  真的进请求，并在 R05 贡献记录里留下版本与内容 hash）；作者侧 `GET/PUT /api/novel/editing`、`GET /api/novel/editing/rules`、
  只读 `POST /api/novel/editing/scan`；模型侧不可开关规则（`PUT` 对 `X-Novel-Agent` 403）。
- 三档编辑（轻度润色 / 去 AI 腔 / 深度修稿）+ 七项能力 + 题材档；界面「创作上下文」页渲染编辑规则卡
  （`frontend-test` 58h—58j）。
- 证据：`.p1-baseline/test-editing-rules.mjs`（隔离实例：规则进请求 / 关闭不进 / 题材门控 / 模型侧只读 / 确定性扫描）
  **45 通过 / 0 失败**。
- **已补验（有限预算）**：真实 DeepSeek 上「去 AI 腔改写 + 改动清单」（`edit_deai`）与「指出植入的时间线矛盾」（`review_semantic`）通过；
  **文学气质的人工阅评**是主观项，不在自动验收范围（如实记「未做人工评阅」）。

### R08 完整长正文处理 —— PASS

- 移除目标正文的 6000 / 12000 字**切片**路径：整章正文作为处理目标，不再被静默截断。
- 新增 `public/long-text.js`（`VERSION '1.0.0'`）：分段（`segment_id`）+ 覆盖清单 + 候选合并 + 部分失败 / 陈旧 / 取消语义；
  越界拒绝；续跑后覆盖清单必须通过；取消不产生可合并结果。
- 证据：`.p1-baseline/test-long-text.mjs` **58 通过 / 0 失败**（含尾部哨兵确实处理、多片覆盖无遗漏、邻接段不被重复编辑）。
- **未执行（如实记录）**：真实模型对 4 万字级长章的端到端成文——本次预算优先用于 §6.2 的六类能力探针与整链冒烟；
  长文分段/覆盖/续跑机制已由离线 58/0 覆盖。

### R09 作者样文、文风档案与三级作者意图 —— PASS（真实模型语义已补验）

- 新增 3 张作者侧表 `author_samples` / `style_profiles` / `author_intents`（1.7.0 契约条目）与门控上下文层
  `author_intent`（默认关闭：作品没有任何作者意图与启用样文时该层不存在，`assembled`/manifest 与接入前逐字节一致）。
- 作者侧端点：样文 CRUD/启用/上限（`/api/novel/style/samples`）、文风档案（`/api/novel/style/profile`，**确定性计数**，
  不调用模型；样文集变化 → 旧档案自动 `stale`）、三级作者意图（`/api/novel/author_intent`）。
  模型侧（`X-Novel-Agent`）只能读，写一律 403；**样文只作风格证据，不进入 `story_facts`/事件/角色知识**。
- 证据：`.p1-baseline/test-author-style.mjs`（隔离实例：上限 / 过期 / 证据预算 / 冲突呈现 / 模型侧只读 / 不进事实）
  **52 通过 / 0 失败**。
- **已补验（有限预算）**：真实 DeepSeek 的 `style_profile` 探针——风格要点引文可在样文中回溯；确定性计数与证据预算仍由离线 52/0 覆盖。

### R10 契约、知识边界与流程闭环增强 —— PASS

- 新增 `ai/story-state/disclosure.mjs` + 只读端点 `GET /api/novel/state/disclosure`（1.8.0 契约条目）：
  按 `chapter_id` 时点重算**作者真相 / 作者计划 / 已撤回 / 角色信念**四个视图；读者披露是**派生视图**，
  事实变化/撤回后自动失效重算；带指纹便于对账。
- POV 行为受 `CHARACTER_KNOWLEDGE` 约束：角色只能"知道"其掌握范围内的信息（越界不出现在其视图里）。
- 证据：`.p1-baseline/test-disclosure.mjs`（隔离实例：分层 / 角色知识边界 / 时点 / 回滚 / 指纹）**31 通过 / 0 失败**。
- **已补验（有限预算）**：`contract_suggestion` 探针——真实模型给出 must_facts ≥ 2 / red_lines ≥ 1 且结构合法（见 §6.2）。

### R11 剧情分支沙盘（2—5 候选）—— PASS（真实推演已补验）

- 新增 2 张表 `branch_sandboxes` / `branch_candidates`（1.9.0 契约条目；候选 = 核心行动/冲突/人物选择/节拍/后果/风险/铺垫/意图关系 +
  依赖基线 hash + 来源，采纳记录在 `adopted_json`）与端点族 `/api/novel/branch/*`（开沙盘 / 列表 / 比较 / 采纳 / 丢弃 / stale 复核 / 取消恢复）。
- **候选不是本书事实**：未采纳不得进正典（不进 `assembled` 的事实层）；重新采纳前必须复核依赖基线（章节正文变化 → `stale` →
  必须显式复核）；采纳只写蓝图（不写正文/事实）；模型侧可提候选但不能采纳/丢弃（403）。取消后可恢复且已产出候选原样保留（不重跑）。
- 证据：`.p1-baseline/test-branch-sandbox.mjs`（隔离实例：候选形状 / 差异判据 / 知识边界 / 采纳只写蓝图 / stale 复核 / 取消恢复）
  **66 通过 / 0 失败**。
- **已补验（有限预算）**：`branch_deduction` 探针——真实模型给出恰 2 个互不相同的候选且结构合法；
  「候选不进正典、采纳只写蓝图」仍由离线 66/0 覆盖。

### R12 导入后的 AI 状态重建 —— PASS（真实模型抽取已补验）

- **导入安全**（新增 `ai/import/guard.mjs`，`IMPORT_GUARD_VERSION 1.0.0`）：TXT / Markdown / EPUB 基线能力**不倒退**
  （TXT/MD/EPUB 在本次任务前就受支持，本轮的 EPUB 侧由 `test-import-guard.mjs` 的 B1—B3 与插件冒烟 `test/smoke.mjs` §8i 双证）；
  新增拒绝面：archive 条目名必须相对/正斜杠/无 `.`·`..` 段/深度 ≤ 16/长度 ≤ 512（绝对路径与反斜杠一律拒绝）、
  条目数 ≤ 2000、单条目解压 ≤ 128MB、整包 ≤ 256MB、单条目压缩比 ≤ 200:1（压缩炸弹判据）、只接受 stored(0)/deflate(8)、
  符号链接条目拒绝、编码严格解码（非法编码拒绝）、正文 ≤ 8M 字符 / 单章 ≤ 2M / 章节数 ≤ 2000；
  **失败不得留下半导入状态**（零半导入），传输层 413 可见。
- **重建流程**（新增 `ai/import/rebuild.mjs` / `rebuild-store.mjs`，`REBUILD_VERSION/EXTRACTOR/SCHEMA 各 1.0.0`）：
  9 类抽取对象；按章节顺序分批（每批 ≤ 6 章且 ≤ 12000 字符，整本不得作为一次请求发送）；每批带**基线指纹**
  （源 hash / 抽取器版本 / schema 版本 / 路由 / 分类任一变化都改变哈希）；断点续跑或重试（≤ 3 次）；≤ 4000 批、
  每批 ≤ 200 项、单项 ≤ 2000 字符、引文 4—600 字符；**抽取结果先是候选**（不落正式状态、不凭空生成隐藏作者真相、
  不覆盖手动资料）；作者显式**按批原子确认**才应用；宿主不调用任何模型（抽取由调用方按批执行，界面提供「复制提示词给 dsh」）。
- **迁移幂等与损坏库**：`.p1-baseline/test-migration-idempotent.mjs` **13 通过 / 0 失败**（空库建 46 张表 /
  重复启动 schema 指纹与行数不变 / 旧库副本只读指纹仍等于冻结值 / 损坏库非零退出且不改原文件）。
- 证据：`.p1-baseline/test-import-guard.mjs` **30/0**、`.p1-baseline/test-import-rebuild.mjs` **28/0**、
  `.verify-enh/migration-idempotent.log`。
- **已补验（有限预算）**：`import_extract` 探针——真实模型对**自造短文本**抽出的实体/事件带可回溯证据；未上传任何真实书稿；
  分批/断点/按批原子仍由离线 28/0 覆盖。
## 3. 任务书 §18 负向/回归用例覆盖映射

| # | §18 用例 | 覆盖测试（唯一 ID = 套件文件 + 套件内断言） | 结果 |
| --- | --- | --- | --- |
| 1 | 非法 action 不调用 apply；未授权/过期/跨作品批准不能写入 | `test-agent-write-boundary.mjs`（24/0，含阴性对照）+ `test-approval-boundary.mjs`（50/0，G3/G4：失败不吞授权、失败后可重试） | PASS |
| 2 | 正文事务中途注入 SQLite 失败 → 正文/历史/提案/状态一起回滚 | `test-adopt-atomic.mjs`（36/0，C 组事务原子与回滚） | PASS |
| 3 | 采纳成功但 OV 失败 → 正文保留、投影待恢复、重启可重试 | `test-adopt-atomic.mjs`（E 组投影可见 / F2/F3 重启只凭 outbox 续跑、attempts 递增） | PASS |
| 4 | 重复提交 / 并发编辑 / 同章旧 hash / 切章 / 删章 / 取消不得错误覆盖 | `test-adopt-atomic.mjs`（幂等键同键同载荷回放、同键不同载荷 409、基线 hash 不符拒绝）+ `test-approval-boundary.mjs`（切章/跨书）+ `test-branch-sandbox.mjs`（B27 取消/恢复）+ `frontend-test.mjs` 107i（补丁基于目标章正文） | PASS |
| 5 | 重复 anchor / 包含型非唯一 anchor / 重叠 patch / 空 patches / 非法 JSON | `frontend-test.mjs` 89（空补丁=合法 no-op）、90b/90c（非唯一/重叠显式失败）、解析严格路径 | PASS |
| 6 | 长章尾部哨兵确实处理；多片覆盖无遗漏；邻接段不被重复编辑 | `test-long-text.mjs`（58/0） | PASS |
| 7 | 无样文 / 空样文 / 档案过期 / 关闭能力 / 缺契约 / unknown / 作者手动保存 | `test-author-style.mjs`（52/0）+ `test-editing-rules.mjs`（45/0，关闭不进请求） | PASS |
| 8 | 两本书同名不同身份：召回不串书；同书未来章不提前泄密 | `test-ov-recall-boundary.mjs` A2/A5/A6/A8 + B2（跨书未进 assembled） | PASS |
| 9 | 未采纳剧情候选被回忆成已发生事实 | `test-ov-recall-boundary.mjs` A9/A13（候选 non_canon 拦截）+ `test-branch-sandbox.mjs`（候选不进正典、采纳只写蓝图） | PASS |
| 10 | 作者全局偏好共享能力不被书籍隔离破坏 | `test-ov-recall-boundary.mjs` A5（合法命中放行）+ `verify-all` 装配回归「P1 基线 vs 当前（真实）IDENTICAL」 | PASS（间接） |
| 11 | 投影 rebuild 不删作者长期记忆/其他作品/DSH 会话/共享技能 | `test-ov-recall-boundary.mjs` D 组（范围证明失败 → 拒绝执行、零删除；rebuild 默认 dry-run） | PASS |
| 12 | `syncTurns=false` 与已排队写入符合锁定版本与 UI 提示 | `.p1-baseline/test-sync-gate.mjs`（16/0） | PASS |
| 13 | 导入中断恢复不重复入账 / 不覆盖手动资料 / 不凭空生成隐藏作者真相 | `test-import-rebuild.mjs`（28/0：候选不落正式状态、按批原子确认、只读 SQLite 阴性对照）+ `test-migration-idempotent.mjs`（13/0） | PASS |
| 14 | 新功能关闭的旧作品上下文基线/模型/思考/路由/菜单/数据不回归 | `verify-all`（装配回归 IDENTICAL、I1/I2/I3/I7 不变量、故事状态端到端 75/0）+ `frontend-test.mjs`（260 断言 ALL PASS） | PASS |
| 15 | 旧 st/session、作者注、角色卡、世界观、长期记忆、正文、版本、草稿、提案、搜索、导出、原有导入正常 | 既有套件（上下文缓存 19/0、召回缺口 17/0、编辑距离 11/0）+ `test-import-guard.mjs` B 组（TXT/MD/EPUB 基线不倒退）+ `frontend-test.mjs` | PASS |
| 16 | source bundle / 实际加载模块 / GUI preset / manifest / 工具·端点契约版本一致 | `verify-plugin-tools.mjs`（25 工具/68 端点/0.14.0 一致）+ `test-host-contract.mjs`（28/0）+ `probe-harness-tool-loop.mjs`（7/0） | PASS |
| 17 | 日志/错误/响应没有真实 API Key 或不必要正文泄露 | `test-context-contributions.mjs`（27/0，脱敏与"不记完整正文"断言）+ `check-utf8.mjs --self-test`（7/0）+ 套件总闸 | PASS（定向断言；非全仓秘密扫描器） |
| 18 | 正文/样文/导入/召回里的 prompt injection 不改系统规则、工具权限、审批与写入行为 | 链路防线各有独立测试（写入边界 24/0、审批 50/0、导入剥标签 B3b/B3c、召回 fail-closed 38/0），但**没有**「注入文本进上下文后逐字节断言系统规则/工具面不变」的专门红队用例；真实模型侧本轮未做注入红队 live | **部分覆盖 / SKIP**（原因见 §6.4） |
| 19 | EPUB/ZIP 路径穿越、绝对路径、zip bomb、超大归档、恶意 HTML/script、外部资源引用安全失败 | `test-import-guard.mjs` B3b/B3c（script/img/远程 URL 不进正文）、B4（`../` 穿越）、B5（symlink）、B6（压缩炸弹）、B7（超大归档）、编码严格 | PASS |
| 20 | 新 migration 在空库/旧库副本/重复启动/中途失败下 schema 与数据正确 | `test-migration-idempotent.mjs`（13/0）+ `test-host-contract.mjs` D（旧库只读指纹 3cb7e5d9ac4f67b9） | PASS |
| 21 | 同一 idempotency key + 同 payload 重放不重复写；不同 payload 必须冲突 | `test-adopt-atomic.mjs`（同键同载荷回放返回原结果、同键不同载荷 409） | PASS |
| 22 | 离线测试里故意保留真实 Provider 配置时，总闸/隔离仍阻止真实外部请求 | `.p1-baseline/audit-llm-calls.mjs --self-test`（本地假端点自证 / 未归属判红）+ `.p1-baseline/fake-llm.mjs` 断言的端点归属 | PASS |
## 4. 隔离、零计费与清理

**隔离配方**（每个自动化测试都用）：临时数据目录 `NOVELSTUDIO_DATA_DIR`（`%TEMP%` 下随机名）＋ `NOVELSTUDIO_OV_DISABLED=1`
（离线测试）或本地 OV stub；隔离端口（`ci-isolated-run.mjs` 分配，本次用 **3739**；探针假 LLM 端点 **2611**；OV stub 端口由测试自选）；
不注入真实 Provider Key；涉及 DSH 子进程的探针自设**本地假模型端点**，且断言请求实际命中该端点（`fake-llm.mjs`/探针端点侧请求序列）。

**本轮两处实机验收**（§6.2）按授权显式使用真实 Provider：能力探针把真实库 `api_configs` 第 1 行**只读**读出，
只放进发往隔离实例的请求体（证据 JSON 里的密钥已全部掩码为 `sk-***93(len=35)`）；整链冒烟走 `ci-isolated-run.mjs` 隔离实例，
模型调用由 dsh 自带凭证完成。两处均不写真实库/真实作品，日志与证据不含密钥。

**零计费证据链**：
- `.p1-baseline/audit-llm-calls.mjs --self-test`（CI 内，通过）：本地假端点自证**不判红**、未归属调用**必须判红**；
- `verify-all` 的「套件总闸：本次未产生真实 LLM 调用」**通过**（窗口内 dsh 会话 0 条，均无「请求 + 模型产出」）；
- 本次任务**付费调用 8 次**（仅 §6.2 两处实机验收；其余全部零计费）：能力探针 7 次 / 2226 tokens ≈ ¥0.013；
  整链冒烟 1 次 / 10591 tokens ≈ ¥0.022；合计 ≈ **¥0.035**（保守上限单价自检口径：输入 ¥2/百万、输出 ¥8/百万；账单以 provider 为准），≤ 授权 ¥2。

**真实资源只读清单（本任务未写入）**：`data/novel.db`（真实库；被三处**只读**打开：host-contract D、`verify-continuity-guard-on-real-data.mjs`（显式
`readOnly: true`）、能力探针 `probe-live-capabilities.mjs`（只读第 1 行 `api_configs` 构造请求体，不落盘））；`.p1-baseline/data/novel.db`（冻结副本，只读）；
`~/.dsh-novel`（novel bundle 安装位只读核验——Junction 指回仓库；写作任务按设计在其中写会话元数据，不改任何配置）；`~/.dsh`（未触碰）；`~/.openviking`（未触碰；
`env-tools-test.mjs` 用 `OPENVIKING_CLI_CONFIG_FILE` 指向临时目录）。真实作品/正式 OV namespace：**全程未使用**（测试全部临时目录 + stub）。

**清理**：本任务创建的临时数据目录已删除（今天删除 `ns-dbg-GpxqdU`、`ns-dbg3-NLQPEJ`、`ns-dbg4-yEPlsv`、
`ns-dbg5-LTy31W`、`novel-studio-ci-3739-17752`；更早删除 3 个今天的数据目录与 326 个临时脚手架文件）。
实机验收（§6.2）另创建并已删除：`%TEMP%\ns-smoke-chain-c5db8dd6`（整链冒烟的隔离数据目录，跑完即删，连同隔离库）；
探针的 `ns-live-*` 临时目录由脚本自删；本轮另清掉 1 个遗留脚手架 `.p1-baseline/.tmp-probe-apiconfig.cjs`。
`%TEMP%` 里仍存在 **2026-09-25**（本任务开始前）的 `novel-studio-ci-3738-*` 等遗留目录，**未动**（不属于本任务创建的资源）。

## 5. Migration、兼容与回滚

- **表**：契约 `db.tables` 共 **46** 张；本任务新增 **11** 张（author_approvals / adoption_operations / projection_outbox /
  ov_projection_audit / author_samples / style_profiles / author_intents / branch_sandboxes / branch_candidates /
  import_rebuild_runs / import_rebuild_batches），全部 `CREATE TABLE IF NOT EXISTS`；另有 1 处附加列
  `ALTER TABLE branch_sandboxes ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`（存量行按未知来源处理，语义不变）。
- **旧库兼容**：旧库副本（1.0.0 冻结）只读打开，schema 指纹仍为 **3cb7e5d9ac4f67b9**，冻结的全部表都在（host-contract D）。
- **重复启动/中途失败**：`test-migration-idempotent.mjs` 13/0（空库建 46 张表 → 写入 → 再次启动指纹/行数不变；
  损坏库非零退出且原文件字节不变）。
- **回滚**：R 阶段在 `docs/phase-map.md` 里声明为 `shared` —— 新模块被生产代码 import，**不能单独回滚**；但交付是**附加式**的：
  三个门控层（story_state / edit_rules / author_intent）与自动压缩开关都默认关闭，关闭时装配/默认生成路径与接入前**逐字节一致**
  （`verify-all`「装配回归：P1 基线 vs 当前（真实）IDENTICAL」）。
- **备份/恢复**：本次未做破坏性操作，未执行恢复演练；库级快照/恢复能力沿用既有 P6 快照工具
  （`node .p6-cutover/test-snapshot.mjs` → CI 内「全量快照工具离线测试」通过）。

## 6. FAIL / BLOCKED / SKIP 逐条（不含糊）

### 6.1 FAIL（1 条，**先于本任务存在**）

| 项 | 明细 | 归因 |
| --- | --- | --- |
| `连续性预检在真实作品上成立（命中/误报/豁免闭环）` | 命中 4 / 漏报 1 / 误报 0；第五章漏 `system_frequency`（系统面板/出场频率）；豁免闭环正常 | 该检查对作者真实作品（work#18，只读）比对既有审稿报告的期望表。预检实现 `ai/continuity-guard.mjs` / `ai/continuity-guard-source.mjs` **未被本任务修改**（`git status` 可证），失败与 R01—R12 无关；如实保留 FAIL，不掩盖 |

> 该 FAIL 的真实数据只读打开，未产生任何写入；`verify-all` 的「真实库未被删改（app_logs 差集归因）」通过。

### 6.2 付费实机验收（本次已执行；授权口径「预算2元以内」）

| 项 | 结果 | 依据 |
| --- | --- | --- |
| 真实 DeepSeek 能力探针（去 AI 腔改写 / 语义审稿 / 样文风格 / 剧情推演 / 契约建议 / 导入抽取；7 次调用） | **7 通过 / 0 失败** | 每项都做实质断言而非「HTTP 200 即过」：改写≠原文且给出 changes；审稿必须指出**植入的时间线矛盾**；样文引文可在原文回溯；推演恰 2 个互异候选；契约 must_facts ≥ 2 / red_lines ≥ 1；抽取的实体/事件带可回溯证据。2226 tokens ≈ ¥0.013。证据：`.verify-enh/live-capabilities-2026-09-27.{log,json,console.log}`（密钥已掩码，7 个 JSON 请求体中的 key 字段现为 `sk-***93(len=35)`） |
| P6 真实写作整链冒烟（真 dsh → 真 DeepSeek → 临时作品；1 次调用） | **7 通过 / 0 失败** | 路由 `POST /api/harness/run` → 真 dsh（provider=deepseek-official / model=deepseek-flash / reasoningEffort=max，34 个工具面，1 turn）。临时作品建 → 写作任务 → 校验产出（158 字正文，~6s）→ 删除；10591 tokens ≈ ¥0.022。证据：`.verify-enh/smoke-chain-2026-09-27.{log,usage.json}` |
| 预算闸门（调用前记录硬上限，触顶即停） | **未触顶** | 探针自设闸门：调用 7 ≤ 8、单次 max_tokens ≤ 512、输出 1408 ≤ 30000、总 2226 ≤ 120000、超时 120s、重试 0 次；实机合计估算 ≈¥0.035 ≤ ¥2。账单口径以 provider 为准 |

### 6.3 仍 BLOCKED（2 类，外部依赖缺失）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 真实 OpenViking 双闭环（作品资源链 + 会话链，含断网/鉴权/超时/重启/pending replay） | BLOCKED | 本机 `127.0.0.1:1933` 未监听（`.verify-enh/ov-port-probe-run2.log`，2026-09-27 当晚复测；`3737` 同样未监听）；写入型 live 需要带测试标识的专用 account/peer/work/session/resource namespace，当前无法证明足够隔离。离线侧已用本地 stub 覆盖 38/0 |
| 真实浏览器 E2E（首页/致谢/进入作品/创作上下文/样文/档案/意图/知识/契约/编辑/审稿/剧情候选/采纳/投影恢复/导入/重启恢复） | BLOCKED | 本环境无浏览器驱动可用；DOM 桩执行（vm+DOM）不能冒充真实浏览器 ⇒ 如实 BLOCKED，不以桩充真 |

### 6.4 SKIP（有意不做，或环境缺前置）

| 项 | 原因 |
| --- | --- |
| §18#18「prompt injection 专用红队用例」 | 链路各道防线（写入白名单/审批/导入剥标签/召回 fail-closed）都有独立测试，但**没有**专门把注入文本喂进上下文再逐字节断言系统规则不变的红队用例；真实模型侧本轮未做注入红队 live（本次实机预算按 §6.2 优先级执行）。如实记「部分覆盖 / SKIP」，不伪造 |
| verify-all 的 6 条跳过 | ① I4 端到端可查回（需按层逐个实调端点，缺前置）② 主成文路径与创作内核同源（隔离实例服务的是别的库）③–⑥ 会真 spawn dsh 或建真实任务的三条+1 条活实例检查（需显式授权；跳过≠通过）。其中「真实写作整链冒烟」已在本次单独执行（§6.2，7/0）；verify-all 套件本体仍保持零计费 |

**收尾时修掉的一处测试假红（不含在产品语义里）**：CI 首跑时 `作者样文/文风档案/三级意图` 出现一次「隔离实例未就绪」（18s 就绪窗口内没等到；本机端口段被别的监听者占住 / 单次 fetch 卡死所致）。已把 9 个会起隔离实例的 R 套件从「`端口 = 基数 + pid % N`」改为**向系统申请空闲端口**（bind 0 → 取端口 → 关闭，失败回落原算法），并把就绪等待从 60×300ms 提到 120×300ms；改后单跑与 CI 全跑（45/45）全绿。

## 7. 复验命令速查

```
node scripts/ci-offline-checks.mjs                                                   # 45 条，零计费
node frontend-test.mjs                                                               # 260 断言 ALL PASS
node .p1-baseline/test-host-contract.mjs                                             # 28/0，契约 1.10.0
node .p1-baseline/verify-plugin-tools.mjs                                            # 25 工具 / 68 端点一致
node .p1-baseline/probe-harness-tool-loop.mjs                                        # 真 spawn dsh，7/0（零计费）
node .p1-baseline/probe-live-capabilities.mjs                                        # 真实模型六类能力（会计费；--dry 只看计划不调用）
$env:NOVELSTUDIO_SMOKE_ALLOW_BILLING='1'                                               # 真实写作整链冒烟（会计费；需用户授权预算）
node scripts/ci-isolated-run.mjs --port 3739 --data %TEMP%\ns-smoke -- node .p6-cutover/smoke.mjs --base http://127.0.0.1:3739
node .p1-baseline/test-migration-idempotent.mjs                                      # 13/0
node .p1-baseline/test-agent-write-boundary.mjs                                      # 24/0
node .p1-baseline/test-approval-boundary.mjs                                         # 50/0
node .p1-baseline/test-adopt-atomic.mjs                                              # 36/0
node .p1-baseline/test-ov-recall-boundary.mjs                                        # 38/0
node .p1-baseline/test-context-contributions.mjs                                     # 27/0
node .p1-baseline/test-editing-rules.mjs                                             # 45/0
node .p1-baseline/test-long-text.mjs                                                 # 58/0
node .p1-baseline/test-author-style.mjs                                              # 52/0
node .p1-baseline/test-disclosure.mjs                                                # 31/0
node .p1-baseline/test-branch-sandbox.mjs                                            # 66/0
node .p1-baseline/test-import-guard.mjs                                              # 30/0
node .p1-baseline/test-import-rebuild.mjs                                            # 28/0
node scripts/ci-isolated-run.mjs --port 3739 -- node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3739
node .p1-baseline/verify-continuity-guard-on-real-data.mjs                           # 真实作品只读对照（当前 FAIL，见 §6.1）
```

## 8. 改动文件清单（23 个已跟踪文件被修改 + 29 个新增条目）

**宿主/内核**：`server.js`（契约 1.10.0；R02 审批端点与 403；R03 adopt；R04 投影 replay/rebuild/audit；R05 contributions；
R07 editing；R09 style/author_intent；R10 disclosure；R11 branch；R12 导入守卫与重建路由）、`db.js`（11 张新表 + 深度感知事务原语）、
`zip-reader.mjs`（R12 归档边界）、`ai/context/layers.mjs`（门控层）、`ai/story-state/index.mjs`、`ai/story-state/store.mjs`。
**新增内核**：`ai/import/{guard,rebuild,rebuild-store}.mjs`、`ai/branch/{sandbox,store}.mjs`、`ai/context/contributions.mjs`、
`ai/editing/{rules,scan}.mjs`、`ai/openviking/recall-meta.mjs`、`ai/style/{store,author-profile}.mjs`、
`ai/story-state/{approval,disclosure}.mjs`、`public/long-text.js`。
**前端**：`public/app.js`、`public/index.html`、`public/styles.css`（R06 改名与致谢页 + R07/R08/R09/R10/R11/R12 界面）。
**插件**：`harness-plugins/novel-writing/{plugin.json,package.json,novel-tools.mjs}`（0.14.0 / 25 工具 / 68 端点）。
**契约/文档**：`docs/host-contract.md`、`docs/host-contract.v1.json`、`docs/phase-map.md`（再生成）、`README.md`、
`docs/新手入门.md`、`THIRD-PARTY-NOTICES.md`；新增 `docs/enhancement-{audit,acceptance,progress}`、`docs/plugin-runtime-map.md`、`docs/openviking-call-map.md`。
**测试**：`scripts/ci-offline-checks.mjs`（清单 32→45）、`frontend-test.mjs`、`.p1-baseline/verify-phase-map.mjs`，
新增 13 个 `.p1-baseline/test-*.mjs`（R02/R03/R04/R05/R07/R08/R09/R10/R11/R12/迁移）与 `probe-live-capabilities.mjs`（手动、有限预算，不进 CI）。
**实机证据（新增）**：`.verify-enh/live-capabilities-2026-09-27.{log,json,console.log}`、
`.verify-enh/smoke-chain-2026-09-27.{log,usage.json}`、`.verify-enh/ov-port-probe-run2.log`。

> 开工时工作区**干净**（`git status --porcelain` 0 行）⇒ 以上全部改动都是本任务的；本任务**未**执行
> `commit / tag / push / merge / rebase / reset / clean / stash`，未切换分支，未 `git add`。
