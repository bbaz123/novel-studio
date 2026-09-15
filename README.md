# Novel Studio · 小说创作工坊

Novel Studio 是一个本地运行的小说创作管理工具，用于管理多部作品的设定、剧情线、大纲、正文写作，并把 AI 辅助创作能力整合进一个清爽的界面。

它不需要安装任何 npm 第三方依赖，使用 Node.js 内置能力与本地 SQLite 数据库即可运行。你的作品数据、API Key 默认只保存在本机。

**当前版本：v0.9.3（运行追踪版）**

| 仓库 | 地址 | 说明 |
| --- | --- | --- |
| 应用本体 | <https://github.com/bbaz123/novel-studio> | 工坊主程序（本仓库），创作插件源码内置在 `harness-plugins/novel-writing/`，与工坊同仓维护、一起升级 |
| 创作插件 | <https://github.com/bbaz123/novel-writing-plugin> | novel-writing 插件（DeepSeek Harness 创作内核）的独立发布镜像，内容与上面 `harness-plugins/novel-writing/` 同步 |

安装步骤见下文「🚀 安装与运行（详细步骤）」。

---

## ✨ 功能亮点

### 作品管理

- 多部作品管理，完整层级：**作品 → 卷 → 章节 / 场景**
- 未进入作品时（初始页），侧栏提供 **「我的作品」** 与 **「✨ AI 创作」** 两个入口
- 作品支持新建、编辑简介、删除
- 一键导入示例小说《雾都缝匠》（演示世界观词条/角色卡/长期记忆/事件账本/反 AI 腔红线），可随时删除

### 重新整理后的侧边栏

进入作品后，左侧只保留几个大栏目，避免界面杂乱：

- **总览**：作品数据总览、最近更新、快捷入口
- **正文写作**：章节树 + 富文本编辑 + AI 写作
- **小说设定**：剧情线、大纲、设定库、角色、长期记忆
- **AI创造板块**：AI 设置、SillyTavern 设置（AI 创作已移到初始页）

### 小说设定板块

集中管理所有与“故事设定”相关的内容，**每个页签都支持 ✨ AI 生成**（AI 会先一次只问一个问题澄清需求，可跳过；自动参考当前作品已有设定，生成后确认/勾选再入库）：

- **剧情线**：主线 + 支线，章节节点时间线预览；支持 ✨ AI 生成（可一次规划多条线勾选入库）
- **大纲**：思维导图 / 列表两种模式，支持卷、章节 / 场景树；支持 ✨ AI 大纲（一次生成整卷“卷+每章标题/摘要”的章节框架，勾选导入）
- **设定库**：分类 + 标签 + 词条详情，支持在正文中关联词条；支持 ✨ AI 批量词条（自动归入/新建分类）
- **角色**：基础档案、外貌、性格、背景、当前状态、人物关系、剧情线级状态；支持 ✨ AI 完整角色卡（含对话示例与系统提示，可多个勾选入库；人物关系/剧情线级状态弹窗也可 AI 回填）
- **长期记忆 / 故事摘要**：记录已发生的重要剧情、伏笔、角色状态变化，AI 写作时会自动带入；支持 ✨ AI 起草记忆与作品/章节作者注起草

### 正文写作

- 富文本编辑：加粗、斜体、下划线、标题、引用、列表
- 自动保存、实时字数统计（统一按纯文本口径，带格式的正文不会虚增字数）
- 单栏 / 两栏 / 三栏布局切换
- 手动保存历史版本，可查看与恢复
- 正文内选中文字可关联设定词条，悬停预览、点击跳转
- 右侧参考面板可快速查看设定、角色与 AI 上下文
- 工具栏「✍️ AI 写作」点击后先弹**需求确认框**（含「直接开始」），确认后才发起付费调用，避免误触扣费

### AI 创作能力

- **入口位置**：AI 自动创建小说 / AI 创作工作台 / 创作任务历史位于**初始页**（未进入作品时，侧栏「✨ AI 创作」）；进入作品后不再显示，专注写作
- **AI 设置**：管理 DeepSeek / OpenAI 兼容 API 配置，支持连接测试（初始页 AI 创作页内与作品内 AI创造板块均可进入）
- **AI 写作 / 续写**：在正文工具栏使用；AI 会先向你提问，一次只问一个问题，根据你的回答继续追问，直到理解需求后再生成正文
- **AI 润色、扩写、细纲、性格校对**
- **AI 自动创建小说**：输入一段描述，AI 自动完善设定并创建作品，创建成功自动进入新书
- **AI 创作工作台 / Harness 流水线**：分阶段生成世界观、角色卡、大纲、正文草稿并做一致性审查，完成后可保存为作品。三档策略（快速 / 均衡 / 深度精修）统一使用 `deepseek-flash`，差异体现在**思考强度**（`low` / `high` / `max`）而不是换模型——V4.1 Flash 在 Agentic/编码基准上已反超 V4 Pro，按“重要环节用旗舰模型”的旧思路反而会把关键环节降级到上一代
- **小说设定 AI 生成**：剧情线 / 大纲 / 设定库 / 角色 / 长期记忆 / 作者注的 AI 生成均复用 **novel-writing-plugin**（deepseek-harness）创作内核——ST 式分层上下文（`/api/novel/context` 装配）、一次一问的澄清协议与反 AI 腔红线
- **入账提案确认**：AI 生成任务里提交的事件/记忆先落提案（不直接写入账本），在「AI 写作结果」弹窗勾选采纳，或到「小说设定 → 长期记忆 → 📥 待确认提案」逐条处理
- **伏笔闭环与一致性核对**：`novel_foreshadows` 查未闭合伏笔、正文回收时自动标记 resolved；成文后 `novel_consistency` 核对未闭合伏笔/角色状态/事件账本；AI 成稿可一键写回章节（旧稿自动存历史版本）
- **任务进度与取消**：所有 Harness 慢通道任务都有悬浮进度卡（阶段文案 / 实时耗时 / 输出尾部），输出已过滤内核内部提示词，只显示人话进度；支持「停止」按钮中途取消（会杀掉 dsh 进程树，已生成内容不落库）
- **SillyTavern 设置**：管理角色卡、世界观词条、作者注，用于丰富 AI 上下文（需进入作品后使用）

### 全局能力

- 全局搜索：设定词条 / 章节正文 / 角色 / 剧情线（正文片段自动剥 HTML 标签，并以查询词为中心截取上下文）
- 本地 SQLite 存储，无需外部数据库服务
- 深色护眼主题

---

## 🧠 OpenViking 共享记忆（语义召回 · v0.9.0）

工坊与 OpenViking 共享同一个记忆库：六类小说数据（章节正文 / 长期记忆 / 事件账本与伏笔 / 设定词条 / 角色卡 / 大纲剧情线）会自动渲染成 Markdown 写入 OpenViking（`user/default/resources/novel-studio/<作品id>/`），由它的本地 bge Embedding（512 维）向量化，不额外占用一套模型与向量库。

- **语义召回层**：AI 写作上下文装配新增「相关记忆检索（语义召回）」层——写第 N 章时按当前章节/蓝图/最近事件语义召回全库相关片段（top 8、阈值 0.3、预算 1400 字），正文 AI 写作提示词（蓝图/成文/续写）同样注入召回结果；可在写作页参考面板「上下文」页签预览命中与相关度，并可一键开关。
- **增量同步**：保存/删除章节、词条、角色、记忆、事件等会自动防抖同步到记忆库（2s 合并）；服务器离线时进本地 pending 队列自动重放；`POST /api/novel/semantic_index` 可全量重建索引。
- **dsh 双通道共享**：GUI dsh（web profile）与工坊后台 headless dsh 都安装 `@openviking/dsh-memory-plugin`，写作任务会话自动采集进同一记忆库（跨会话可召回）；`harness.js` 会把 headless 任务归属到工坊 peer（`OPENVIKING_PEER_ID`，可用 `NOVELSTUDIO_OPENVIKING_PEER_ID` 覆盖）。
- **检索语义化**：全局搜索与 `novel_lookup` 叠加语义结果（`/api/search` 返回 `semantic.hits`）。
- **环境变量**：`NOVELSTUDIO_OV_DISABLED=1` 整体停用集成（冒烟测试/隔离环境）；`NOVELSTUDIO_OV_AUTOINDEX=0` 关闭启动自动建索引；OpenViking 地址/凭证走 `OPENVIKING_*` 环境变量 → `~/.openviking/ovcli.conf` → 默认 `http://127.0.0.1:1933`。
- **降级**：OpenViking 服务器不可用时语义召回静默跳过，写作与装配完全不受影响。

---

## 🧾 统一日志系统（诊断与性能监测）

工坊内置零依赖日志系统，对**代码运行错误、阻塞卡顿、慢操作、进程异常**等不正常问题全程记录，每条日志都带**发生时间（毫秒级）**、**技术栈层级**（`layer`）、**代码位置**（文件:行号:函数）与**文件地址**（绝对路径）：

- **双写存储**：SQLite `app_logs` 表（侧栏「🧾 日志」页按级别/层级/关键词筛选查看、展开堆栈、一键清空、每 5 秒自动刷新）+ `data/logs/app-YYYY-MM-DD.log` 滚动 JSONL 文件（应用整体卡死/崩溃后重启仍可排查）；保留策略：数据库最新 5000 条 / 30 天，文件 14 天
- **全层覆盖**：`server`（接口 500 与慢请求 >500ms）、`db`、`harness`（任务开始/完成/超时/退出/构建失败）、`ai`（统一 AI 错误，旧 ai_error_logs 自动迁移）、`openviking`/`sync`（记忆库同步失败/队列丢弃）、`plugin`（dsh 插件进程经 `POST /api/logs` 上报）、`frontend`（浏览器运行时错误/未处理 Promise/慢 API/页面卡顿经 `sendBeacon` 上报）、`process`（未捕获异常/未处理拒绝/退出）
- **主动监测**：事件循环滞后采样（卡顿 >400ms 记 `block`，1.5s 以上升级为错误）、慢操作归因（上下文装配/搜索/导出/全量同步超阈值记 `slow_op` 并定位代码位置）
- **防刷屏**：同层同消息 10 秒窗口去重（AI 错误沿用 30 分钟窗口），进程崩溃时先落日志再退出
- **接口**：`GET /api/logs`（筛选+统计+翻页）、`POST /api/logs`（远端上报，仅接受 frontend/plugin 层）、`DELETE /api/logs`（清空）

---

## 🐞 运行追踪（调试录制 · 代码运行可视化）

顶栏「🐞 运行追踪」按钮是一个**录制开关**：点一下开始，再点一下停止。录制期间，你在界面上的每一次操作都会被记成一条**操作记录**，回答三个问题——**这一步跑了哪些代码、在哪一行、花了多久、得到什么结果**。

- **一个操作 = 一条记录**：按业务语义归并。例如点「AI 写本章」是一条操作，它内部触发的上下文装配、AI 调用、红线扫描、保存等 N 次调用都折叠在这一条下面，可展开看完整调用链。
- **前后端同一条时间线**：前端通过 `X-Trace-Op` 头把操作 id 下发给后端，后端用 `AsyncLocalStorage` 让整条异步链归属同一操作，因此「前端处理器 → HTTP 请求 → 路由 → 业务函数 → SQL → 外部调用」按发生顺序排在一起，每个节点都带 `文件:行号:函数名` 与耗时。
- **Token 用量**：直连通道（`/api/ai/*`）逐次采集 provider 返回的 `usage`（输入/输出 token、缓存命中），挂在对应的 AI 节点上，并在操作、会话两级汇总。
- **分层深度**：业务主干函数全量记录；渲染/字符串/数学这类高频工具函数只累计「调用次数 + 合计耗时」，不逐条展开，避免淹没业务链路。
- **落盘与保留**：明细写 `data/debug/trace-<会话>.jsonl`（内存缓冲 1 秒批量追加，崩溃最多丢 1 秒）。会话文件是**自描述**的——开头有 `session-start`、每条操作结束有 `op-end`（含耗时/Token/是否截断的摘要），因此回看不需要额外的索引表；视图内可查看历史录制、导出 JSON；默认只保留最近 20 个会话文件，可一键清空。
- **安全阀**：单次操作节点数超过上限（默认 2000）后停止采集并在界面上标「已截断（丢弃 N 条）」；`/api/debug/*`、`/api/logs`、`/api/stats`、`/api/harness/job` 等自身与轮询接口不参与追踪，避免「记录行为本身」放大负载。
- **忘关保护**：前端每 10 秒心跳一次，页面关闭后后端 20 秒内自动停止录制。

### 明确的边界（先说清楚，避免误解）

- **不记录正文**：所有参数与返回值都只转成「形状摘要」（类型 / 长度 / 字段名 / 关键 id），长文本用长度占位，**绝不落盘小说正文或提示词正文**；写入型 SQL 也只记绑定值的形状（例如"写入了 12480 字的正文"）。
- **慢通道 Token 不可得**：`/api/harness/*` 走的 dsh 子进程里，headless 驱动显式丢弃了 usage 事件（`dsh-headless/lib/index.js` 的 `case "usage": return;`），stdout 只输出正文，因此那条通道只记到任务级（job id / 状态 / 耗时 / 成败），界面上会明确标注这一原因。
- **高频工具函数**合并计数，不逐条列出（见上文「分层深度」）。

### 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/debug/state` | 当前录制状态、实时统计与上限配置 |
| `POST` | `/api/debug/start` / `stop` / `ping` | 开始 / 停止录制、前端心跳 |
| `GET` | `/api/debug/ops` | 当前会话的操作列表 + 工具函数累计表 |
| `GET` | `/api/debug/op?op_id=` | 单次操作的完整调用链（内存优先，回退会话文件） |
| `GET` | `/api/debug/stream` | SSE 实时推送节点（供追踪页边录边看） |
| `POST` | `/api/debug/op` | 前端回传客户端节点、渲染结果与 toast（与后端节点合流） |
| `GET` | `/api/debug/sessions` / `session?file=` | 历史录制列表 / 读取某个会话 |
| `DELETE` | `/api/debug/purge` | 清空全部录制文件 |

### 已埋点的业务主干（函数级节点）

`server.js`：`search`（关键词检索）、`selectSceneCharacters`（选出场角色）、`buildAIContext`（UI 预览上下文）、`scanAgainstRedlines`（红线扫描）、`buildNovelContext`（创作上下文装配）、`compressStoryMemory`（压缩长期记忆）、`splitTextIntoCapters`（导入拆章）、`installDemo`（导入示例）、`callAI` / `callAIStream`（AI 调用，带 Token）。

`openviking-sync.js`：`syncWorkFull`（记忆库全量同步）、`getSemanticRecall`（语义召回）、`semanticSearchMerge`（检索合并）。

`harness.js`：harness 任务（会话级，含成功/失败/超时/取消四种结局）。

### 测试

```bash
# 后端接口回归（需要隔离实例在 127.0.0.1:3738 运行）
node api-test-suite.mjs

# 前端执行验证（最小 DOM 桩里真跑 public/app.js：渲染、开关、节点上报、形状摘要）
node frontend-test.mjs
```

---

## 🛠️ 最近更新（2026-09 · 运行追踪版 v0.9.3）

- **🐞 运行追踪（新功能）**：顶栏「🐞 运行追踪」一键开始 / 停止录制，把界面上的每一次操作记成一条记录，回答「这一步跑了哪些代码、在哪一行、花了多久、得到什么结果」——按业务语义归并操作、前后端同一条时间线（`X-Trace-Op` 头 + 后端 `AsyncLocalStorage`）、直连 AI 通道逐次采集 Token 用量、业务主干函数级埋点、高频工具函数只累计次数与耗时；明细写 `data/debug/trace-*.jsonl`（自描述会话文件，默认保留最近 20 个），支持边录边看、历史回看与导出 JSON
- **不记录正文**：所有参数与返回值只落「形状摘要」（类型 / 长度 / 字段名 / 关键 id），绝不写盘小说正文与提示词正文；单次操作节点超上限（默认 2000）自动截断并在界面标注；忘关保护由前端心跳 + 后端 20 秒兜底自动停止
- **长任务续接与结果取回**：AI 写作 / 审稿的成稿草稿与审稿报告一律落库，刷新页面或切换章节后编辑器顶部出现「取回」条——可续接仍在跑的任务，或取回已完成的结果并应用；「已完成未应用」标记统一走「服务端写标记 + 本地列表同步刷新」，不再常驻
- **harness 并发与互斥修复**：`runHarnessJob` / `resumeHarnessJob` 的「检查—置位」竞态窗口用 try/finally 收口（GET 失败等提前 return 也不再泄漏锁）；只有需要改写 `settings.yaml` 的任务才串行，其余并行
- **思考强度可调 + 模型分工校正**：新增 `reasoning_effort`（`off | low | high | max`，进入全局互斥前先校验非法值并给出明确报错）；三档创作工作台统一 `deepseek-flash`，差异体现在思考强度而不是换模型
- **上下文按用途瘦身**：`novel_context` 新增 `settings` 模式（设定类生成只去掉当前场景 / 蓝图 / 前文衔接层，质量层零丢失）；headless profile 关闭与写作无关的通用工具（pwsh / 子代理 / 计划模式 / skill 等），省下的上下文留给创作
- **验证**：接口回归 **147/147**、前端执行验证 **34/34**、插件冒烟 **32/32**；运行追踪另经三轮「追踪记录 × 运行日志」交叉对账复核（见 docs/run-trace-review-round3-2026-09-14.md）

## 🛠️ 最近更新（2026-09 · 新人体验优化版 v0.9.2）

依据《新人使用体验报告》（docs/novice-experience-report.md）修复 13 项问题：

- **AI 写作中文编码修复（P0）**：harness 任务不再经 pnpm→cmd.exe 启动（中文 prompt 会被 ANSI 损坏成「?」），改为按 dsh 仓库 `scripts.dsh` 定义直接 node spawn；headless 插件 baseUrl 改 `NOVELSTUDIO_BASE_URL` 环境变量优先，多实例不再串写主库
- **AI 失败可见**：AI 写作异常/空输出时弹错误框并回显 AI 原始输出尾部，不再静默失败
- **记忆库防串作品（P0）**：作品级 OpenViking 目录标识（works.ov_uri + 新作品自动分配随机目录名），旧作品保持原目录；同步全部改单文件 replace 写入（服务端 batch 对新建文件返回 404、upsert 不被支持），实测四类文件完整落库
- 相关度显示修正（不再出现「8800%」）、后台标签页不再被误报「主线程阻塞」、测试连接结果驻留显示、AI 通道慢请求阈值放宽至 10s、示例导入提示按「设定词条/世界观词条」双口径、ST 设置页词条体系说明、关闭服务确认文案口语化、侧栏折叠按钮加提示、语义召回过滤目录元数据与空占位
- 修复详情见 docs/fix-summary-2026-09-06-novice.md

## 🛠️ 最近更新（2026-09 · 统一日志系统版 v0.9.1）

- **统一日志系统**：双写（SQLite + 滚动文件）、全层覆盖（服务端/harness/AI/OpenViking/插件进程/浏览器前端/进程级）、错误+卡顿+慢操作主动监测、每条日志带时间/技术栈层级/代码位置/文件地址
- 侧栏新增「🧾 日志」页：按级别/层级筛选、搜索、统计、堆栈展开、清空
- 冒烟测试扩至 30 组（新增日志系统 7 组断言：lifecycle/远端上报/非法层拒绝/筛选统计/文件落盘/500 入账/清空）

> 📚 更早的更新记录（共 7 条：v0.9.0 及以前）已存档到 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

---

## 🚀 安装与运行（详细步骤）

### 第 0 步：环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows / macOS / Linux | Windows 可直接用仓库里的 `start-novel-studio.cmd` 一键启动 |
| Node.js | **22.5 或更高** | 使用内置 `node:sqlite`，**不需要执行 `npm install`** |
| 浏览器 | Chrome / Edge / Firefox 等现代浏览器 | 界面是纯前端页面，无构建步骤 |
| 磁盘 | 约 50 MB（不含作品数据） | 作品数据库位于 `data/`，随使用增长 |

检查 Node 版本：

```bash
node -v      # 需要 v22.5.0 或更高
```

### 第 1 步：获取代码

```bash
git clone https://github.com/bbaz123/novel-studio.git
cd novel-studio
```

不想用 Git 的话，打开仓库页面点 **Code → Download ZIP**，解压后进入 `novel-studio` 目录即可。

### 第 2 步：启动服务

Windows（推荐，自动开服务窗口并打开浏览器）：

```text
双击 start-novel-studio.cmd
```

任意系统（命令行）：

```bash
npm start
# 等价写法
node server.js
```

看到启动日志后，浏览器访问：

```text
http://localhost:3737
```

**换端口**（默认 3737 被占用时）：

```bash
# Windows PowerShell
$env:PORT=3738; npm start

# macOS / Linux
PORT=3738 npm start
```

**换数据目录**（多实例 / 隔离测试）：

```bash
$env:NOVELSTUDIO_DATA_DIR="D:\novel-data"; npm start
```

首次启动会自动创建 `data/novel.db` 与全部表结构，无需手动建库。

### 第 3 步（可选）：创建桌面快捷方式

```powershell
powershell -ExecutionPolicy Bypass -File .\create-desktop-shortcut.ps1
```

会在桌面生成「小说工坊」快捷方式（带图标），双击等同运行 `start-novel-studio.cmd`。

### 第 4 步：配置 AI（要用 AI 创作才需要）

见下文「🤖 AI 功能配置」——在应用内填 Base URL / API Key / 模型即可，密钥只存本地 SQLite。

### 第 5 步（可选）：安装 DeepSeek Harness 与创作插件

只做手动写作不需要这一步；要用「AI 写作 / 创作工作台 / 自动创建小说」这类会调用创作内核（角色卡 / 世界观 / 红线）的功能才需要。

1）准备一份 DeepSeek Harness（dsh）仓库，并告诉工坊它在哪：

```bash
# Windows PowerShell
$env:NOVELSTUDIO_DSH_REPO = "C:\path\to\deepseek-harness"
npm start
```

2）安装创作插件。源码就在本仓库 `harness-plugins/novel-writing/`，独立发布仓库为 <https://github.com/bbaz123/novel-writing-plugin>：

```powershell
# 预演（不写任何文件）
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -DryRun

# 安装 / 升级（区块合并安装，不动你 profile 里的其它 patch 条目）
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1

# 卸载
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Uninstall
```

安装会把 `novel_*` 工具同时注册到 headless profile 与 GUI preset，旧的安装区块会自动识别并替换。

### 第 6 步（可选）：导入示例作品

首屏「🧪 示例小说」区块可一键导入《雾都缝匠》演示数据（`demo-data.json`），用来熟悉界面。

### 升级到新版本

```bash
git pull
npm start
```

数据库会在启动时自动迁移（新表 / 新列），已有作品不受影响。

### 自检（可选）

```bash
# 插件端到端冒烟（不依赖 dsh / 模型 / API Key）
node harness-plugins/novel-writing/test/smoke.mjs

# 接口回归：需先在 127.0.0.1:3738 起一个隔离实例
node api-test-suite.mjs

# 前端执行验证（最小 DOM 桩里真跑 public/app.js）
node frontend-test.mjs
```

---

## 🤖 AI 功能配置

AI 相关功能需要先配置可用的模型后端。

### 1. 配置 API（在应用内完成）

在初始页（未进入作品）点击侧栏「✨ AI 创作」→「⚙️ AI 设置」；进入作品后也可在「AI创造板块 → AI 设置」配置：

```text
✨ AI 创作 → AI 设置     （初始页）
AI创造板块 → AI 设置     （作品内）
```

新建 API 配置并填写：

- 配置名称
- Base URL（DeepSeek 默认 `https://api.deepseek.com`）
- API Key
- 模型（下拉可选 `deepseek-flash`（DeepSeek-V4.1-Flash，**默认且推荐**）/ `deepseek-v4-pro`（上一代 Pro，更贵更慢）；其它 OpenAI 兼容服务商的自定义模型名同样兼容）
  - ⚠️ **模型优先级：功能内置的模型参数 > 这里的 `model`**。功能内置分工由 `public/app.js` 顶部两个常量单点控制（`server.js` 有同名 `QUALITY_AI_MODEL`，两处需同步改）：
    - `DEFAULT_AI_MODEL = deepseek-flash` —— 快而省的环节：提问/澄清、质检轮、入账整理、润色/扩写/细纲/性格校对、AI 写作、批量生成、创作工作台三档；
    - `QUALITY_AI_MODEL = deepseek-v4-pro` —— 直接产出正文/整部设定，或结果会喂给之后每一章的环节，按「质量优先」不省：成文轮、AI 审稿、AI 修稿、AI 自动创建小说、长期记忆压缩。
    - 因此**改这里的 `model` 不会影响上述功能**；该字段仅对未固定模型的功能生效（当前为连接测试，以及仅供 API 调用的 `/api/ai/generate_novel`）。要调整分工请改上述常量。
  - 已下线的模型名不再出现在下拉框中：`deepseek-chat` / `deepseek-reasoner` 官方已于 2026-07-24 停止服务，`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 已由 V4.1 Flash 取代（旧名仍会被服务端路由到 V4.1 Flash）。存量配置中那两个已停止服务的名字会在启动时自动改写为 `deepseek-flash`。
- 温度、最大 Token

### 2. 配置 DeepSeek Harness（可选但推荐）

本项目的 AI 创作 / 深度写作通过 `deepseek-harness`（dsh）执行。若未安装，AI 写作与自动创作可能不可用。

可以通过环境变量指定 Harness **仓库**所在目录（推荐使用专属变量，避免与 dsh 官方的 `DSH_HOME` profile 目录语义冲突）：

```bash
# Windows PowerShell
$env:NOVELSTUDIO_DSH_REPO = "C:\path\to\deepseek-harness"
npm start

# macOS / Linux
export NOVELSTUDIO_DSH_REPO="/path/to/deepseek-harness"
npm start
```

路径解析顺序：`NOVELSTUDIO_DSH_REPO` → `DSH_HOME`（仅当该目录下存在 `package.json` 时才采用）→ 工坊仓库同级的 `deepseek-harness` 目录 → 内置默认路径。在其它电脑上运行时请按实际路径设置。

> 单轮短任务（润色 / 扩写 / 性格校对 / 细纲等）会优先走「AI 设置」里配置的 API 直连通道（秒级响应），只有需要调用创作内核（角色卡 / 世界观 / 红线）的任务才会经过 Harness 慢通道。

---

## 🧭 界面导航速览

| 入口 | 说明 |
| --- | --- |
| 我的作品 | 未进入作品时默认显示，管理所有小说项目 |
| ✨ AI 创作 | 未进入作品时显示：AI 自动创建小说 / 创作工作台 / 创作任务历史 / AI 设置 |
| 总览 | 当前作品的章节数、设定数、角色数、剧情线数 |
| 正文写作 | 选择章节并写作，支持 AI 写作与富文本排版 |
| 小说设定 | 剧情线 / 大纲 / 设定库 / 角色 / 长期记忆 |
| AI创造板块 | 进入作品后显示：AI 设置 / SillyTavern 设置 |
| 🐞 运行追踪 | 作品内外均可访问：录制开关 + 按操作分组的调用链、Token 汇总、筛选、历史录制回看与导出 |
| 🧾 日志 | 作品内外均可访问：统一日志系统的错误/慢操作/进程异常记录 |

> 顶栏常驻「🐞 运行追踪」按钮可直接开/关录制，不必先进入追踪页；录制中按钮显示「● 录制中」。

---

## 📁 项目结构

```text
novel-studio/
├── public/
│   ├── index.html      # 页面骨架与侧边栏
│   ├── styles.css      # 样式与深色主题
│   └── app.js          # 前端交互逻辑
├── db.js               # SQLite 初始化与建表（含事件账本/记忆版本/红线/入账提案/app_logs 表）
├── server.js           # HTTP 服务与 API 路由（含 /api/novel/* 创作内核、/api/logs 日志接口）
├── harness.js          # DeepSeek Harness 桥接层（模型切换互斥 + CAS 还原）
├── logger.js           # 统一日志系统（SQLite+文件双写/卡顿与慢操作监测/保留策略）
├── debug-trace.js      # 🐞 运行追踪引擎（AsyncLocalStorage 操作归组/分层埋点/形状摘要/上限截断/JSONL 落盘）
├── openviking.js       # OpenViking 客户端（凭证解析 + 离线 pending 队列）
├── openviking-sync.js  # OpenViking 同步层（六类数据渲染 + 语义召回）
├── text-utils.js       # 共享文本工具（HTML→纯文本，server.js 与 openviking-sync.js 共用）
├── api-test-suite.mjs  # 隔离实例(127.0.0.1:3738) 接口回归测试（零依赖，自清理）
├── frontend-test.mjs   # 前端执行验证（最小 DOM 桩里真跑 public/app.js，零依赖）
├── assets/             # 图标资源（novel-studio.ico 桌面快捷方式图标、preview.png 多尺寸预览）
├── novel-studio-icon.ps1 # 图标生成脚本（渲染 preview / 打包 ico / 应用到桌面快捷方式）
├── demo-data.json      # 示例小说《雾都缝匠》演示数据（“我的作品”页一键导入，可选）
├── harness-plugins/novel-writing/   # 内置创作插件（dsh 侧唯一来源；发布镜像见 novel-writing-plugin 仓库）
│   ├── novel-tools.mjs              # novel_* 工具集（headless 与 GUI preset 同源）
│   ├── agent.cordis.yml / preset.yml# GUI 会话 preset
│   ├── headless-cordis.patch.yml    # headless profile 注入区块（合并式安装）
│   ├── install.ps1                  # 安装/升级/卸载（-DryRun/-Uninstall）
│   ├── plugin.json                  # 清单：工具/端点/契约
│   ├── test/smoke.mjs               # 端到端冒烟测试（node:test 风格断言）
│   ├── ENGINE.md / NATIVE_PLUGIN_GUIDE.md / README.md
├── package.json
├── start-novel-studio.cmd
├── create-desktop-shortcut.ps1
└── data/               # 本地数据库（不会上传到 Git）
```

---

## 🗄️ 数据与隐私

- 所有数据保存在本机：`novel-studio/data/novel.db`；运行日志位于 `data/logs/`（14 天自动清理）
- 运行追踪的录制明细位于 `data/debug/trace-*.jsonl`（默认保留最近 20 个会话，可在追踪页一键清空）；**其中不包含小说正文与提示词正文**，只含代码位置、耗时与长度等形状信息
- API Key 也只保存在本地 SQLite 数据库中
- `data/` 目录（含数据库备份目录 `data/backup-*` 与 `data/debug/`）已被 `.gitignore` 排除，**不会随仓库上传**
- 首次启动时如果数据库不存在，程序会自动创建所需的表结构

---

## ⚠️ 注意事项

- 请勿将 `data/novel.db` 直接分享或上传，其中可能包含你的 API Key 与作品内容
- AI 请求会发送到你配置的模型服务商；如使用云端服务，请注意敏感信息
- 若修改了 `server.js` 或 `db.js`，重启服务后生效
- 本项目基于 DeepSeek Harness（dsh）的 AI 能力开发，有问题请直接询问 dsh
- 应用本体仓库：<https://github.com/bbaz123/novel-studio>
- 创作插件仓库（发布镜像）：<https://github.com/bbaz123/novel-writing-plugin>
- 借鉴开源项目：SillyTavern，利用其世界观等特色加深 AI 写作能力
