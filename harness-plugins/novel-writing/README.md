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
   ├─ novel-tools.mjs           # novel_* 工具集（headless 与 GUI preset 同源）
   ├─ agent.cordis.yml          # GUI 会话 preset（写作人设 + novel_* 工具 + fs）
   ├─ preset.yml                # preset 元信息
   ├─ headless-cordis.patch.yml # 注入 headless profile 的区块片段（合并式安装）
   ├─ install.ps1               # 一键安装/升级/卸载（区块合并、保留用户其它 patch）
   ├─ plugin.json               # 清单：工具/端点/契约（文档与测试的唯一真源）
   ├─ test/smoke.mjs            # 端到端冒烟测试（自研断言脚本，未使用 node:test）
   ├─ ENGINE.md                 # 架构、端点、验收细节
   ├─ NATIVE_PLUGIN_GUIDE.md    # 如何在工坊内扩展本插件
   └─ README.md                 # 本文件
```

## 安装（详细步骤）

前置条件：

- **Node.js 22.5+**（工坊本体用内置 `node:sqlite`，**无需 `npm install`**）
- 一份**已构建的 DeepSeek Harness（dsh）仓库** + headless profile（插件要装进它的 profile）
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
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun

# 安装 / 升级（区块合并：只替换本插件区块，你 profile 里的其它 patch 条目原样保留）
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 卸载
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

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

# dsh 侧工具目录
cd <你的 deepseek-harness 目录>
pnpm dsh --profile headless "只输出一行：你当前可用的全部工具名称，用逗号分隔"
# 期望出现：novel_context, novel_works, novel_lookup, novel_scan, novel_style_contract,
#           novel_event_add, novel_memory_update, novel_foreshadows, novel_foreshadow_update,
#           novel_consistency, novel_blueprint, novel_review, novel_chapter_save
```

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `novel_context` | 取作品/章节分层上下文（大纲/记忆/事件/未闭合伏笔/本章蓝图/目标字数/前后章衔接/角色卡/激活世界观/红线），分层预算截断 |
| `novel_works` | 列出作品（确认 work_id） |
| `novel_lookup` | 关键词检索角色/词条/章节/剧情线（写前查证设定） |
| `novel_foreshadows` | 列出未闭合（或全部）伏笔 |
| `novel_foreshadow_update` | 标记伏笔状态（resolved/dropped/open，可回链回收事件） |
| `novel_consistency` | 成文后一致性核对：未闭合伏笔/出场角色状态/最近事件 vs 正文（蓝图为核对锚点） |
| `novel_scan` | 确定性反 AI 腔红线扫描（可跳过引号内对话） |
| `novel_style_contract` | 读取写作红线清单 |
| `novel_event_add` | 事件/伏笔/状态变化入账（伏笔状态与回收、幂等去重；headless 先落提案） |
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
- **分层上下文预算**：每层独立上限、红线/角色卡保底、总量收敛截断，超长记忆标注压缩提示，
  不再一刀切盲截。
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

## v0.9.3 更新：设定轻量装配 + headless 瘦身（本版重点）

- **`novel_context` 新增 `settings` 模式**：设定类生成（世界观 / 角色卡 / 大纲 / 长期记忆等）只去掉「当前场景 / 本章蓝图 / 前后章衔接」三层，质量层（红线、角色卡、世界观词条、长期记忆、事件账本、未闭合伏笔）零丢失，省下的上下文留给真正要产出的内容。
- **headless profile 瘦身**：`headless-cordis.patch.yml` 关闭与创作无关的通用能力——`agent-instructions`（省 ~4.1k）、`tool-pwsh`（最大的单个工具 schema）、`workflow` / `subagent` / `subagent-fork` / `subagent-control` / `subagent-list-agents`、`todo` / `goal` / `jobs` / `ralph`、`plan-mode`、`web`、`skill` / `skill-filesystem`、`session-title-llm`；`novel_*` 工具与 read / write / edit / glob / grep、persona、OpenViking 记忆插件全部保留。
- **冒烟测试扩至 32 组**：新增 `settings` 模式轻量装配断言（验证质量层不丢失）。

## v0.8.0 更新：上下文质量与性能

- **评分制出场角色**：出场角色不再「按名字前 8 兜底」，改为评分制选择——剧情线关联 > 正文/摘要命中次数 > 蓝图·作者注·最近事件提及 > 最近章节摘要出场 > 人物关系网；上限 16，兜底按最近出场优先。
- **别名与整词命中**：角色卡新增「别名/称呼」字段（`characters.aliases`，可界面编辑），上下文与一致性核对都按正式名+别名命中；单字 CJK 名称要求词边界，杜绝「云」命中「云彩/李云」类子串误报。
- **角色卡核心保底**：出场角色卡层不再整层头部盲截（旧实现会把靠后的角色整卡切掉），改为逐卡截断 + 每卡名字/身份/性格/当前状态必保，长字段分级压缩。
- **上下文预览页签**：写作页参考面板新增「上下文」页签——预览 AI 实际收到的分层装配与出场角色名单，可勾选角色强制带入本章（章节级覆盖，存 `chapters.context_character_ids`）。
- **角色状态闭环**：`novel_consistency` 为每个出场角色附带相关最近事件，供 AI 判断状态是否过时；AI 用 `novel_event_add(kind="character")` 记录状态变化，作者在角色面板「⏱ 状态事件」一键同步为当前状态。
- **上下文缓存与性能**：`/api/novel/context` 装配结果内存缓存（任何写操作经 `touchWork` 自动失效）；长章节只按需转换头部/尾部纯文本（`plainTextHead/Tail`），不再整章全文剥标签；补齐剧情线角色与人物关系索引；dsh 工具 GET 连接失败自动重试一次；冒烟测试新增出场角色选择断言与大作品（120 章+50 角色）装配基线。

## 卸载 / 回退

```powershell
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Uninstall
```

- 删除 `~/.dsh/.agent-presets/novel-writing`（GUI preset）
- 从 `~/.dsh/profiles/headless/cordis.patch.yml` 中整段移除本插件区块（保留其它 patch 条目）
- 工坊服务端的新表/新列向后兼容（旧功能不受影响），建议保留

## 环境要求

- Windows（安装脚本为 PowerShell；模块为纯 ESM JS，无第三方依赖）
- Node.js 22.5+（novel-studio 本体）+ 已构建的 deepseek-harness（dsh）仓库 + headless profile
- novel-studio 本地服务（http://127.0.0.1:3737，`PORT` 可覆盖；dsh 工具通过 `NOVELSTUDIO_BASE_URL` 自动定位）
- 应用本体仓库：<https://github.com/bbaz123/novel-studio>
- 创作插件仓库（发布镜像）：<https://github.com/bbaz123/novel-writing-plugin>
