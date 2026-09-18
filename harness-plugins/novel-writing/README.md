# Novel Writing 创作插件（内置版 · 面向 Novel Studio）

这是 **Novel Studio（小说创作工坊）内置的创作插件**：插件的 dsh 侧源码与工坊服务端创作内核**同仓维护、一起升级**，不是独立分发的第三方组件。

| 仓库 | 地址 | 说明 |
| --- | --- | --- |
| 应用本体 | <https://github.com/bbaz123/novel-studio> | 工坊主程序。插件规范源就在它的 `harness-plugins/novel-writing/`，**安装请优先用这一份** |
| 创作插件 | <https://github.com/bbaz123/novel-writing-plugin> | 本目录的独立发布镜像（本目录内容即该仓库根），与规范源保持同步 |

```
novel-studio/
├─ db.js / server.js / harness.js / public/app.js   ← 工坊主体（创作内核：上下文装配/红线/事件账本/记忆版本/提案确认）
└─ harness-plugins/novel-writing/                   ← 本插件（dsh 侧唯一来源）
   ├─ package.json              # bundle 包声明（dsh.bundle.patch → cordis.patch.yml）
   ├─ cordis.patch.yml          # bundle 补丁层：创作人设 + novel_* 工具 + 通用能力瘦身
   ├─ novel-tools.mjs           # novel_* 工具集（后台任务与 GUI preset 同源）
   ├─ agent.cordis.yml          # GUI 会话 preset（写作人设 + novel_* 工具 + fs）
   ├─ preset.yml                # preset 元信息
   ├─ install-profile.mjs       # profile 接线器（bundles + junction + 旧痕迹清理）
   ├─ install.ps1               # 安装入口（-Profile / -DryRun / -Uninstall）
   ├─ plugin.json               # 清单：工具/端点/契约（文档与测试的唯一真源）
   ├─ test/smoke.mjs            # 端到端冒烟测试（自研断言脚本，未使用 node:test）
   ├─ ENGINE.md                 # 架构、端点、验收细节
   ├─ NATIVE_PLUGIN_GUIDE.md    # 如何在工坊内扩展本插件
   ├─ headless-cordis.patch.yml # 【已弃用】旧区块合并片段，仅为对照保留
   └─ README.md                 # 本文件
```

## 安装（详细步骤）

前置条件：

- **Node.js 22.13+**（工坊本体用内置 `node:sqlite`，**无需 `npm install`**。
  ⚠️ **22.5–22.12 会起不来**：`node:sqlite` 到 [v22.13.0](https://nodejs.org/docs/latest-v22.x/api/sqlite.html) 才不再需要 `--experimental-sqlite`；旧文档写的「22.5+」是错的）
- 一份**已构建的 DeepSeek Harness（dsh）仓库** + 目标 profile（插件要装进它的 profile）
- Windows（`install.ps1` 是 PowerShell 脚本；插件模块本身是跨平台纯 ESM，无第三方依赖）

**第 1 步：装工坊本体**

```bash
git clone https://github.com/bbaz123/novel-studio.git
cd novel-studio
npm start            # 打开 http://localhost:3737；数据库启动时自动建表 / 迁移
```

工坊仓库已内置创作内核，不需要覆盖任何补丁文件、也不需要单独装本插件才能跑工坊本体。

**第 2 步：装 dsh 侧插件**（本目录；发布镜像仓库中本目录即仓库根）

```powershell
# 预演（不写任何文件，先看会改哪些路径）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile novel -DryRun

# 安装 / 升级到专用 profile `novel`（novel-studio 后台任务用）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile novel

# 卸载
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile novel -Uninstall
```

`-Profile` 省略时默认 **`novel`**——与 `harness.js` 的默认值一致（P6 起后台写作任务跑在
**专用 profile `novel`** 上，不再用共享的 `headless`）。装到别的 profile 用 `-Profile <名字>`。
安装做的事：

1. 把 GUI preset 复制到 `~/.dsh/.agent-presets/novel-writing/`；
2. 让目标 profile 在 `dsh.profile.bundles` 里列出 `novel-writing`，并在它的 `node_modules`
   下建立指向本目录的 **junction**——工坊仓库即唯一来源，**没有副本**；
3. 识别并清理旧版安装留下的区块与 `novel-tools.mjs` 副本（带备份）。

因为走 junction，改完本目录的代码**立即生效**，不需要重跑安装（重启 novel-studio 即可）。

若工坊本体不在默认位置，启动工坊前用环境变量指定 dsh 仓库路径：

```bash
# Windows PowerShell
$env:NOVELSTUDIO_DSH_REPO = "C:\path\to\deepseek-harness"
npm start
```

完成后打开 novel-studio 使用 AI 创作即可——后台 headless dsh 自动携带 novel 工具与创作纪律，
无需在 dsh 界面手动选 preset（身份经 `NOVELSTUDIO_WORK_ID/CHAPTER_ID/MODE` 环境变量注入）。

## 验证

```bash
# 服务端冒烟测试（不依赖 dsh，纯 HTTP 断言；需能定位到 novel-studio 仓库，
# 或用 NOVELSTUDIO_REPO 环境变量指定其根目录）
node test/smoke.mjs

# dsh 侧工具目录（PROFILE 换成你安装时用的 profile，例如 novel）
cd <你的 deepseek-harness 目录>
pnpm dsh --profile novel "只输出一行：你当前可用的全部工具名称，用逗号分隔"
# 期望出现：novel_context, novel_works, novel_lookup, novel_scan, novel_style_contract,
#           novel_event_add, novel_events, novel_memory_read, novel_memory_update,
#           novel_foreshadows, novel_foreshadow_update, novel_consistency, novel_blueprint,
#           novel_review, novel_chapter_save（共 15 个）

# 零成本挂载验证（不出网、不产生 API 费用：把端点指向本机死端口，观察是否报 TRANSPORT）
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:1'
pnpm dsh --profile novel "Reply with the single word: ok"
```

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `novel_context` | 取作品/章节分层上下文（大纲/记忆/事件/未闭合伏笔/本章蓝图/目标字数/前后章衔接/角色卡/激活世界观/红线），分层预算截断 |
| `novel_works` | 列出作品（确认 work_id） |
| `novel_lookup` | 关键词检索角色/词条/章节/剧情线/**世界观/人物关系**（写前查证设定；也是被预算截断内容的查回入口） |
| `novel_foreshadows` | 列出未闭合（或全部）伏笔 |
| `novel_events` | 读取事件账本（比上下文「最近事件」层更早的记录），可按类型/章节过滤 |
| `novel_foreshadow_update` | 标记伏笔状态（resolved/dropped/open，可回链回收事件） |
| `novel_consistency` | 成文后一致性核对：未闭合伏笔/出场角色状态/最近事件 vs 正文（蓝图为核对锚点） |
| `novel_scan` | 确定性反 AI 腔红线扫描（可跳过引号内对话） |
| `novel_style_contract` | 读取写作红线清单 |
| `novel_event_add` | 事件/伏笔/状态变化入账（伏笔状态与回收、幂等去重；headless 先落提案） |
| `novel_memory_read` | 读取完整长期记忆摘要（上下文里的该层按预算截断到 2200 字） |
| `novel_memory_update` | 长期记忆摘要压缩/增量提交（版本快照可回滚；headless 先落提案） |
| `novel_blueprint` | 保存本章写作蓝图（场景目标/情节点/冲突/钩子/目标字数），作者确认后落库 |
| `novel_review` | 保存成文的审稿报告（总评/问题清单/优点），作者在工坊界面确认清单并按清单修稿 |
| `novel_chapter_save` | 成稿写回章节正文（旧稿自动存历史版本，返回红线扫描） |

## 关键机制

- **章节蓝图（写前规划）**：AI 写作流程先出蓝图（场景目标/情节点/冲突与转折/角色状态变化/钩子/参考设定）
  → 弹窗确认可修改 → 落库（`chapters.blueprint_json`）→ 按蓝图成文；蓝图随上下文带入并作为
  `novel_consistency` 的核对锚点；生成失败自动降级为直接成文，不阻塞。
- **每章目标字数控制**：作品级默认（`works.default_chapter_words`，默认 2000，可 3000/5000/自定义）
  + 章节级覆盖（`chapters.target_words`）；成文不足目标时工坊自动续写补足（≤2 轮拼稿），
  结果弹窗按目标对比提示；作品还可配置总章数/故事结构/叙事视角参与大纲与蓝图生成。
- **审稿→修稿闭环**：成文后可「先审稿再应用」——审稿报告（总评/问题/优点）→ 逐条确认/忽略
  → 按确认清单修稿 → 段落级差异预览（新增绿/删改红）→ 合并到正文（旧稿存历史版本）。
- **批量章节生成**：从第一个无正文章节顺序生成 N 章（≤10），每章自动蓝图→成文→字数补足→写回；
  可随时停止，失败即停（已完成章节保留）。
- **伏笔/叙事线索面板**：写作页右侧参考面板「伏笔」页签——分组展示、跳转埋设章节、
  标记回收/废弃/恢复，与事件账本共用状态。
- **导入导出**：TXT/Markdown/EPUB 导入（自动拆章、新建作品，EPUB 零依赖 zip 解析）；
  整书 TXT/Markdown 与单章 TXT 导出。
- **提案确认（headless 防污染）**：novel-studio 网页启动的任务带 `NOVELSTUDIO_PROPOSE_MODE=1`，
  AI 的事件/记忆入账先落提案表，任务结束随结果返回；作者在「AI 写作结果」弹窗勾选采纳，
  或稍后在「小说设定 → 长期记忆 → 📥 待确认提案」里处理。GUI dsh 会话里作者在场，直接入账。
- **伏笔闭环**：`novel_foreshadows` 查欠账 → 正文显式呼应 → `novel_event_add(resolves_event_id=…)`
  自动把旧伏笔标记 resolved；作者确认废弃/恢复时用 `novel_foreshadow_update` 直接改状态；
  `novel_context` 里始终带【未闭合伏笔】层。
- **分层上下文预算（P1–P2 重构后）**：层规格是**单点机读**的（`ai/context/layers.mjs` 的 `LAYERS`，
  13 层分 `fixed`/`flex`/`cond`/`entity` 四类，`fixed` 为**零损失层、永不参与收敛**）；
  总预算 full/continuation/fragment **26,000** / settings **18,000**，**可执行下限由 `computeFloor()`
  自动核算**（当前 20,547 / 17,356）——不再手写常量。压到下限仍超预算时**显式报 `overflow`**，
  不静默超限。契约的不变量 I1–I7 见 `docs/context-contract.md`。
- **凡裁剪必可查回（I4）**：每个会被裁剪的层都在 `RETRIEVAL` 里声明**查回路径**（用哪个工具能取回原文），
  并由 `verify-retrieval` 实测；做不到查回的层**不允许裁剪**。模型侧入口：长期记忆 → `novel_memory_read`、
  事件账本 → `novel_events`、伏笔 → `novel_foreshadows(status=all)`、红线 → `novel_style_contract`、
  其余（世界观/蓝图/人物关系/角色/章节）→ `novel_lookup`。
- **语义召回缺口不静默（D8-#5）**：`buildNovelContext` 在「长期记忆」之后装配【相关记忆检索（语义召回）】层；
  期望有召回却拿不到时（OpenViking 不可用/未就绪），改为发一层**显式占位**（「本次不可用，原因=X」），
  而不是整层消失。两个响应端点同步回传 `gap`/`gap_reason`，判据单点在 `layers.mjs` 的 `recallGapReason`。
  主动停用（`disabled`）与查询为空（`empty`）**不算缺口**——那是意图不是意外，插占位只会制造噪声。
- **长期记忆压缩的零损失护栏（D8-#3）**：压缩是**有损**操作，而长期记忆会喂给之后每一章——
  丢一个角色，摘要照样通顺、**不会报错**。判据按「章节正文里出现过没有」确定性分**两侧**：
  ① **出场过的**（主角+配角，含别名变体）一个都不许丢 → **拒绝落库**并指名缺失名单；
  ② **从未出场的**若被提及 → **默认放行但如实记日志**（用户规格「根据剧情需要出现」是允许），
  需要严格时设 `NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1`。
  两个入口共用同一份判据 `ai/memory-compress-guard.mjs`：服务端自动压缩作业，
  以及**模型自压缩**（`novel_memory_update` 传 `summary`，靠 `guard:'agent'` 标记来源）。
  **作者在工坊界面手改长期记忆不带该标记，不受影响**。
- **多关键词加权检索**：`/api/search` 支持多关键词 AND 匹配、名称/标题加权排序、片段定位；
  前端高亮命中关键词并按类型分组展示。
- **红线扫描与风格契约**：默认 28 条反 AI 腔红线，作品级可覆盖（`PUT /api/novel/redlines`）；
  扫描支持 `skip_dialogue`（引号内台词不计）与**整词豁免**（每条红线可配豁免词，
  如「眸 → 豁免 眼眸/回眸/眸色」）；作品可配置**正向风格要求**随红线一起进入写作上下文；
  写作页参考面板「红线」页签可查看清单并**界面化管理**（增删改/启用/豁免词）。
- **记忆版本管理**：长期记忆每次保存/回滚自动留版本快照；「长期记忆 → 🕘 历史版本」
  可查看列表、**一键回滚**、**与当前摘要做差异预览**（红色=旧有、绿色=新增）。
- **幂等与保留**：事件按 `dedup_key` 去重；记忆版本每作品保留最近 200 个，超限自动剪除；
  正文写回前自动存章节历史版本；审稿报告每章节保留最近 10 份。

## 安全（本地工具也要防）

- 服务端不再返回 `Access-Control-Allow-Origin: *`：跨源页面无法读取本地 API Key 与作品数据；
  浏览器跨源写请求（POST/PUT/DELETE）一律 403。
- 请求体上限 32MB（EPUB 导入用）；红线正则长度上限 500、豁免词单个上限 100；非法 JSON/非 JSON 响应显式报错。
- 蓝图/审稿/正文写回等写类端点校验 `work_id` 与章节归属，防止串作品误写。

## 插件 0.9.0 更新：按 P0–P6 重构后的内核**完全适配** + AI 能力结合（2026-09-18）

> 版本号有两套，别混：**插件版本**在 `plugin.json`（当前 **0.9.0**，三处必须同步——`plugin.json` /
> `package.json` / `novel-tools.mjs` 的 `PLUGIN_VERSION`）；下面各节标题里的 `v0.9.3` / `v0.8.0`
> 是**工坊本体版本**（根 `package.json`），讲的是服务端能力。

- **文档与清单按重构后的实现逐条对齐**：Node 门槛修正为 **22.13+**、默认 profile 改为 **`novel`**、
  卸载语义改为 bundle+junction、预算改由 `computeFloor()` 自动核算、模型切换机制改写、端点真相修正。
- **AI 能力结合——模型侧真的按内核规则行动，而不只是"服务端有规则"**：
  - **模型自压缩纳入零损失护栏**：此前护栏只保护服务端自动压缩作业，而人设恰恰教模型
    「自行压缩成 ≤800 字再调 `novel_memory_update`」——**那条路没有护栏**，丢一个角色照样静默落库。
    现在两个入口共用 `ai/memory-compress-guard.mjs` 的同一份判据；不通过返回
    **409 + 缺失名单 + `delta` 逃生口**，模型一轮内即可改正。
  - **护栏规则写进人设与工具描述**（`cordis.patch.yml` 与 `agent.cordis.yml` 两侧同步），
    让模型**第一次就写对**，而不是靠被拒后重试——重试就是钱。
  - **召回缺口占位层的含义写进人设**：模型看到「相关记忆检索：本次不可用」时知道这是
    **这一层没来**，而不是"没有相关记忆"，会改用 `novel_lookup` / `novel_memory_read` / `novel_events` 查证。
- **成本纪律**：本次改造**未新增任何工具**（工具面仍是 15 个）；人设净增约 240 字；
  护栏只在本地 SQLite 上做索引查询，**不进 AI 计费路径**，happy path 零额外调用。
  验收：离线单测 `.p1-baseline/test-agent-memory-guard.mjs`（28/28，含阴性对照）、
  插件冒烟 `test/smoke.mjs` **36/36**（新增 4 组护栏端到端断言，其中"作者手改不被拦"是关键阴性对照）。

## 工坊 v0.9.3 更新：设定轻量装配 + headless 瘦身（本版重点）

- **`novel_context` 新增 `settings` 模式**：设定类生成（世界观 / 角色卡 / 大纲 / 长期记忆等）只去掉「当前场景 / 本章蓝图 / 前后章衔接」三层，质量层（红线、角色卡、世界观词条、长期记忆、事件账本、未闭合伏笔）零丢失，省下的上下文留给真正要产出的内容。
- **profile 瘦身**：`cordis.patch.yml` 关闭与创作无关的通用能力——`agent-instructions`（省 ~4.1k）、`tool-pwsh`（最大的单个工具 schema）、`workflow` / `subagent` / `subagent-fork` / `subagent-control` / `subagent-list-agents`、`todo` / `goal` / `jobs` / `ralph`、`plan-mode`、`web`、`skill` / `skill-filesystem`、`session-title-llm`；`novel_*` 工具与 read / write / edit / glob / grep、persona、OpenViking 记忆插件全部保留。这 17 条已用组合树对账验证「声明即生效、无静默失效」（见 `.p0-recon/README.md`）。
- **冒烟测试扩至 32 组**：新增 `settings` 模式轻量装配断言（验证质量层不丢失）。

## 工坊 v0.8.0 更新：上下文质量与性能

- **评分制出场角色**：出场角色不再「按名字前 8 兜底」，改为评分制选择——剧情线关联 > 正文/摘要命中次数 > 蓝图·作者注·最近事件提及 > 最近章节摘要出场 > 人物关系网；上限 16，兜底按最近出场优先。
- **别名与整词命中**：角色卡新增「别名/称呼」字段（`characters.aliases`，可界面编辑），上下文与一致性核对都按正式名+别名命中；单字 CJK 名称要求词边界，杜绝「云」命中「云彩/李云」类子串误报。
- **角色卡核心保底**：出场角色卡层不再整层头部盲截（旧实现会把靠后的角色整卡切掉），改为逐卡截断 + 每卡名字/身份/性格/当前状态必保，长字段分级压缩。
- **上下文预览页签**：写作页参考面板新增「上下文」页签——预览 AI 实际收到的分层装配与出场角色名单，可勾选角色强制带入本章（章节级覆盖，存 `chapters.context_character_ids`）。
- **角色状态闭环**：`novel_consistency` 为每个出场角色附带相关最近事件，供 AI 判断状态是否过时；AI 用 `novel_event_add(kind="character")` 记录状态变化，作者在角色面板「⏱ 状态事件」一键同步为当前状态。
- **上下文缓存与性能**：`/api/novel/context` 装配结果内存缓存（任何写操作经 `touchWork` 自动失效）；长章节只按需转换头部/尾部纯文本（`plainTextHead/Tail`），不再整章全文剥标签；补齐剧情线角色与人物关系索引；dsh 工具 GET 连接失败自动重试一次；冒烟测试新增出场角色选择断言与大作品（120 章+50 角色）装配基线。

## 运行宿主（P0–P6 重构后）

| 项 | 值 | 说明 |
| --- | --- | --- |
| dsh profile | **`novel`（专用）** | 由 `harness.js` 的 `NOVELSTUDIO_DSH_PROFILE` 决定；默认已从共享的 `headless` 切到 `novel`（P6） |
| dsh home | **`~/.dsh-novel`（专用）** | 决策 B：写作任务的 `DSH_HOME` 与 GUI 分开，**消除混版碰撞**。首次启动自建 `profiles/node_modules` 镜像；目录不存在时自动退回共享 home，不会把任务打挂 |
| 插件接入 | **bundle + junction** | profile 的 `dsh.profile.bundles` 列出 `novel-writing`，其 `node_modules/novel-writing` 是指向工坊仓库的 junction——**仓库即唯一来源，没有副本** |
| 创作内核 | 工坊仓库的 `ai/` | `ai/context/layers.mjs`（层规格）、`ai/context/assembler.mjs`（装配器）、`ai/policy.mjs`（模型策略**单点**）、`ai/harness-env.mjs`（子进程环境契约）、`ai/memory-compress-guard.mjs`（零损失护栏） |

启动时会打印一行「写作任务使用专用 DSH_HOME：…」——**这行是有意打的**：`DSH_HOME` 会随**启动方式**
而变（从 DSH 派生的终端启动时环境里已经带着它，从桌面快捷方式启动时没有），不显式说明的话
「B 到底生没生效」只能靠猜。要换位置设 `NOVELSTUDIO_DSH_HOME`；要回到共用就删掉 `~/.dsh-novel`。

> ⚠️ **改完人设或工具后怎么让它生效**：后台任务走 bundle+junction，改仓库即生效，
> 但 `harness.js` 是**启动时加载**的 → 重启工坊服务（`npm start`）才看得到；
> 而 GUI preset（`~/.dsh/.agent-presets/novel-writing/`）那份 `agent.cordis.yml` 是**副本**，
> 要让 GUI 会话也用上新纪律，得重跑一次 `install.ps1`。

## 卸载 / 回退

```powershell
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Profile novel -Uninstall
```

P0 起是 **bundle 安装**，所以卸载是「拆接线」而不是「删补丁区块」：

- 删除 `~/.dsh/.agent-presets/novel-writing`（GUI preset，先带时间戳备份）
- 从目标 profile 的 `package.json` 里移除 `dsh.profile.bundles` 中的 `novel-writing`，
  并删掉它 `node_modules` 下指向本目录的 **junction**（由 `install-profile.mjs --uninstall` 完成）
- **不改写** profile 自己的 `cordis.patch.yml`——P0 起它回归为干净的用户层，安装脚本不再碰它
- 工坊服务端的新表/新列向后兼容（旧功能不受影响），建议保留

> 只有从**旧版**（区块合并 + 复制 `novel-tools.mjs`）升级上来时才需要跑 `install.ps1`：
> 它会识别并清理那两类旧痕迹（带备份）。bundle 走 junction，之后改仓库代码**立即生效**。

## 环境要求

- Windows（安装脚本为 PowerShell；模块为纯 ESM JS，无第三方依赖）
- **Node.js 22.13+**（novel-studio 本体；22.5–22.12 会因 `node:sqlite` 需要 `--experimental-sqlite` 而起不来）
- 已构建的 deepseek-harness（dsh）仓库 + **专用 profile `novel`**（见上文「运行宿主」）
- novel-studio 本地服务（http://127.0.0.1:3737，`PORT` 可覆盖；dsh 工具通过 `NOVELSTUDIO_BASE_URL` 自动定位）
- 应用本体仓库：<https://github.com/bbaz123/novel-studio>
- 创作插件仓库（发布镜像）：<https://github.com/bbaz123/novel-writing-plugin>
