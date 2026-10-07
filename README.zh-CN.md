# Novel Studio · 小说创作工坊

[**English**](README.md) · **简体中文**

[![CI](https://github.com/bbaz123/novel-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/bbaz123/novel-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js ≥ 22.13](https://img.shields.io/badge/node-%E2%89%A5%2022.13-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![npm dependencies: 0](https://img.shields.io/badge/npm%20dependencies-0-brightgreen)](package.json)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#-安装与运行详细步骤)
[![data: 100% local](https://img.shields.io/badge/data-100%25%20local-blue)](#-数据与隐私)
[![model: DeepSeek V4.1 Flash](https://img.shields.io/badge/model-DeepSeek%20V4.1%20Flash-4d6bfe)](ai/policy.mjs)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

**本地运行的 AI 小说创作工坊。** 它把长篇写作必然会遇到的那几件事——**设定漂移、伏笔丢失、角色状态自相矛盾、AI 腔**——做成**可检查、可拦截的机制**，而不是靠提示词碰运气。

**长篇不是在第 3 章崩的，是在第 40 章崩的。** 第 12 章写「李队」、第 40 章变成「李队长」；第 3 章已经死掉的配角重新出场；埋的线到完结都没人回收。对话式 AI 能写出漂亮的段落，却会把情节线丢掉，而且**更长的提示词治不了这个病**。

Novel Studio 把它做成**确定性、可检查的机制**：本机跑一个 Node.js 服务，整座书库就是一个 SQLite 文件，**零 npm 依赖**——不用 `npm install`、不用注册账号、不连云、不订阅。

> **完全不接 AI 也能用。** 纯手写、设定管理、大纲与导出开箱即用、零费用；AI（DeepSeek 或任意 OpenAI 兼容服务商）是可选项，只在你打开开关的功能里才用。

**谁适合用**

- **写 100 章以上长篇的网文 / 连载作者**：经常搞不清设定、角色状态和还没回收的伏笔
- **想用 AI 助手但不愿把稿子交出去的人**：所有内容都留在你自己拥有的本地文件里
- **想把它接进自己流水线的开发者**：界面只是本地 HTTP API 的薄客户端，[75 条端点](harness-plugins/novel-writing/plugin.json)可直接脚本化

**谁不适合用**

- **不是 SaaS**：没有账号、没有云同步、没有协作、没有订阅——它是你自己拥有的、可离线运行的软件
- **不是一键出书机**：AI 产出是草稿或提案，要你点头才落库，不是自动驾驶
- **不是模型厂商**：它不带模型、不卖 token，API Key 是你自己的，费用付给你自己的服务商
- **不是 Agent 框架**：它是一个应用；[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 集成是可选的，只用于重活（成文流水线）

**它和别的工具怎么选**（不打算取代谁，各自有各自的强项）

| 你想要 | 可以先看 | Novel Studio 的差别 |
| --- | --- | --- |
| 一本被专业编辑打磨过的成稿 | [Sudowrite](https://www.sudowrite.com/)、[Novelcrafter](https://www.novelcrafter.com/) | 那些是托管 SaaS，句子级工具更强；本项目的重心是**100+ 章的连贯性**，而不是句子打磨，而且自托管、免费 |
| 离线、纯文本的写作环境 | [Obsidian](https://obsidian.md/) + Longform、[novelWriter](https://novelwriter.io/)、[Manuskript](https://www.theologeek.ch/manuskript/) | 那些是优秀的文件式编辑器，但没有 AI、也没有故事状态；本项目维护**可查询的故事状态**（角色状态 / 事件账本 / 伏笔）并能据此驱动模型 |
| 本地大模型对话前端 | [SillyTavern](https://github.com/SillyTavern/SillyTavern)、[KoboldAI](https://github.com/LostRuins/koboldcpp)、[Open WebUI](https://github.com/open-webui/open-webui) | 那些是对话优先、场景之间刻意无状态的；本项目是**正文优先**，模型读到的是装配好、按预算裁剪过的上下文 |
| 自己写一个写作工具 | 任意 Node.js HTTP 客户端 | 本项目的界面就是本地 API 的薄客户端，你可以直接脚本化同一套内核 |

**一句实话**：Novel Studio 写不出比托管 AI 写作服务更漂亮的**单句**，也不会像人类编辑那样给你一份成熟大纲。它做的是那些工具不做的事——**不让设定漂移、死人复活和伏笔失踪悄悄过去**，而且是在你自己的机器上、免费做这件事。

> 📌 版本 **v1.1.6**（实验版 · 强化版）。本仓库的**默认分支 `Experimental-Version-v1.0` 就是当前开发线**；`refactor/p0-p6` 保留上一版（v0.9.6），`main` 保留重构前的旧版（v0.9.3）。安装方式与项目结构一律以本页为准，收尾说明见 [Release v1.1.4](https://github.com/bbaz123/novel-studio/releases/tag/v1.1.4)。
>
> 🔎 **English keywords**：local-first AI novel writing studio / novel writing software · AI writing assistant · AI 小说写作软件 · Chinese web novel (网文) / long-form fiction · character consistency & foreshadowing tracker · worldbuilding tool · story bible · DeepSeek Harness plugin · Node.js + SQLite · zero npm dependencies · self-hosted & privacy-first, your data never leaves your machine.

![写作台：左侧章节树、中间正文编辑器、右侧实时参考面板——截图取自仓库内一键导入的示例小说《雾都缝匠》](assets/screenshot-writing.png)

---

## 🎯 30 秒讲清它解决什么问题

用对话式 AI 写长篇，通常写到第 20～80 章之间开始崩，症状很具体：

- **设定漂移**：第 12 章写「李队」，第 40 章变成「队长」，前后对不上
- **状态错乱**：第 3 章已经死掉的配角重新出场；角色处境与几十章前的设定冲突
- **伏笔失踪**：埋的线没人回收，或者被当成既成事实提前用掉
- **AI 腔**：满屏「心中一凛」「眼中闪过一丝复杂」
- **失忆**：每次都要手动把设定贴进对话框——贴少了它编，贴多了超上下文

**Novel Studio 的答案不是更长的提示词，而是四件机制：**

- **上下文装配**：写作时自动装配 **14 层**上下文（作品 / 大纲 / 长期记忆 / 语义召回 / 事件账本 / 未闭合伏笔 / 当前场景 / 本章蓝图 / 前文衔接 / 出场角色卡 / 人物关系 / 世界观设定 / 相关设定词条 / 写作红线），按预算裁剪；每个层的「查回路径」都在 [`ai/context/layers.mjs`](ai/context/layers.mjs) 里显式声明，**裁剪不等于静默丢弃**
- **零损失记忆护栏**：压缩长期记忆时，凡是正文里出场过的实体（含别名）**一个都不许丢**，违反直接**拒绝落库**并返回缺失名单
- **反 AI 腔红线**：确定性正则扫描 + 正向风格契约（`writing_redlines` + `style_positive`），写作与审稿两条通道同源
- **一致性核对**：成文后逐项对照未闭合伏笔 / 角色当前状态 / 事件账本 / 已登记命名实体 / 本章边界，冲突如实报出

```text
裸用对话式 AI 写长篇：
  第 12 章「李队」写成「李队长」 · 第 3 章死掉的配角又出场 · 伏笔没人回收 · 每次都要手动贴设定

换成 Novel Studio：
  写作前自动装配 14 层上下文（含角色当前状态与未闭合伏笔）
  成文后一致性核对逐项指出冲突；丢实体的记忆摘要被护栏拒绝入库
```

---

## 🚫 它不做什么 · 什么时候才需要它

- **不需要联网，也不需要 AI**：手写、设定管理、大纲、导出全部本地完成、零费用。**不接 AI 它也是一个完整的小说管理工具**
- **不把作品交给任何服务器**：数据是本机的一个 SQLite 文件；服务只监听 `127.0.0.1`，写请求还会校验 Origin/Host 是否本机（防 DNS rebinding）
- **不含模型、不卖 token**：要用 AI 得自己填 API Key（直连你选的服务商，**会产生费用**）；默认推荐 DeepSeek-V4.1-Flash
- **不是「一键成书机」**：AI 产出的事件/记忆先落「提案」，**你勾选之后才入账**；AI 写的正文写回章节之前也要你确认
- **不替你做创作决策**：AI 会先一次只问一个问题来澄清需求（可以跳过），也可以全程不用 AI
- **不是 SaaS**：没有账号、没有云同步、没有团队协作

---

## ⭐ 功能特性

<a id="-功能亮点"></a>

### 一致性机制（这个项目存在的理由）

- **角色状态一致性**：角色卡带基础档案、当前状态、人物关系与剧情线级状态；装配器把**对应章节时点**的快照送进上下文，成文后再核对一次，谁的行为与状态对不上就报出来。
- **伏笔闭环（不是记事本）**：伏笔在事件账本里是**一等公民**，可标「已埋下 / 已回收」；模型能查询尚未闭合的线，正文回收时自动标记 resolved。
- **设定与世界观真的进上下文**：设定词条、世界观、角色卡、剧情线、长期记忆、事件账本**自动装配**，不必每次手动往对话框里贴。
- **14 层上下文装配**：作品 → 大纲 → 长期记忆 → 语义召回 → 事件账本 → 未闭合伏笔 → 当前场景 → 本章蓝图 → 前文衔接 → 出场角色卡 → 人物关系 → 世界观 → 设定词条 → 写作红线。按预算裁剪，且**凡裁剪必可查回**（每层都给出 `tool_hint`）。
- **零损失记忆护栏**：压缩长期记忆时，凡是正文里出场过的实体（含别名）**一个都不许丢**；违反直接**拒绝落库**并返回缺失名单。
- **反 AI 腔红线**：确定性正则扫描 + 正向风格契约，写作与审稿两条通道同源。
- **成文后一致性核对**：逐项对照未闭合伏笔 / 角色当前状态 / 事件账本 / 已登记命名实体 / 本章边界，冲突如实报出。
- **故事状态内核**：实体 / 时间线 / 伏笔 / 披露 / 知识 / 审批 / 风格质量，通过单一契约暴露。
- **AI 产出先落提案**：AI 抽取的事件与记忆先落「提案」，**你勾选之后才入账**；AI 写的正文绝不自动覆盖章节（旧稿自动存历史版本）。

### 工程特性

- **零 npm 依赖**：`package.json` 里没有 `dependencies`，运行时不引入任何第三方包；用的是 Node 自带的 `node:sqlite`
- **纯 ESM**、无构建步骤（前端是原生页面，改完刷新即生效）
- **CI 零计费**：50 条离线检查 + 隔离实例活测，Windows / Linux 双平台，**绝不调用真实模型**
- **服务只监听 `127.0.0.1`**，写请求校验 `Origin` / `Host`（防 DNS rebinding）

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
- **AI创造板块**：AI 设置、创作上下文（AI 创作已移到初始页）

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
- **创作上下文**：管理角色卡、世界观词条、作者注，用于丰富 AI 上下文（需进入作品后使用；旧称“SillyTavern 设置”，只是历史叫法）

### 全局能力

- 全局搜索：设定词条 / 章节正文 / 角色 / 剧情线（正文片段自动剥 HTML 标签，并以查询词为中心截取上下文）
- 本地 SQLite 存储，无需外部数据库服务
- 深色护眼主题

---

## ✨ 为什么是这套机制

市面上「AI 写小说」的工具不少，差别不在功能清单有多长，而在**出问题的地方有没有机制兜住**。下表是选这套工具时最该先看的几件事。

| 你的处境 | 通用对话式工具 | Novel Studio |
| --- | --- | --- |
| 写到第 20～80 章开始崩（设定漂移 / 伏笔失踪 / 角色状态错乱） | 靠更长的提示词、靠你记得提醒 | **确定性检查**：连续性预检 + 成文后一致性核对，冲突逐条报出 |
| 每次都要手动把设定贴进对话框 | 贴少了它编，贴多了超上下文 | **14 层上下文自动装配**（另有 4 个门控层按作品开关启用；含角色当前状态与未闭合伏笔），按预算裁剪，且裁剪后可查回 |
| 不知道 AI 到底看到了什么 / 这笔钱花在哪 | 只能翻日志或猜 | **可追问**：`context_id` + 逐层溯源，点开参考面板就能核对 |
| 数据与 API Key 放在别人服务器上 | 默认如此 | **只监听 `127.0.0.1`**，数据是本机一个 SQLite 文件 |

> 上方的 [**⭐ 功能特性**](#-功能特性) 是该机制对应的具体功能面。

---

## 🚀 快速开始（Windows 新手版 · 约 3 分钟）

> **只想自己动手写小说？** 不需要 `npm install`、不需要装数据库、不需要联网、不需要 API Key，也不产生任何费用。
> 唯一要装的东西是 **Node.js**。

### 第 1 步 · 装 Node.js（只需装一次）

打开 <https://nodejs.org> → 下载 **LTS 版**（**22.13 或更高**，推荐直接装最新的 24.x）→ 一路「下一步」装完。

装好后按 `Win + R` 输入 `cmd` 回车，在弹出的黑窗口里敲：

```bash
node -v
```

能看到 `v24.x.x`，或 `v22.13.0` 以上的任意版本，就说明装好了。
**如果版本低于 22.13，请下载新版覆盖安装**——原因见下面「🆘 新手常见问题」里 `node:sqlite` 那一条。

### 第 2 步 · 下载本项目

在本仓库页面点绿色的 **`Code` → `Download ZIP`**，解压到一个**路径里不含中文和空格**的目录，例如 `D:\novel-studio`。

（会用 Git 的话：`git clone https://github.com/bbaz123/novel-studio.git`）

### 第 3 步 · 双击启动

进入解压出来的文件夹，**双击 `start-novel-studio.cmd`**。

它会自动弹出一个黑色服务窗口，并帮你打开浏览器。当服务窗口里出现下面这两行、浏览器里出现「📚 我的作品」页面，就成功了：

```text
[logger:server] Novel Studio 服务启动
Novel Studio is running at http://localhost:3737
```

（两行之间可能还有一行自检日志，属正常现象。若浏览器没自动打开，手动访问 <http://localhost:3737> 即可。）

- 以后每次写作都只要重复**第 3 步**：双击同一个文件。
- 想停止服务：在服务窗口里按 **`Ctrl + C`**（推荐，会先把数据落盘再退出），或直接关掉那个黑色窗口。
- 服务**只监听本机**（`127.0.0.1`），同一局域网里的其它设备访问不到，作品不会被别人看到。

<details>
<summary><b>macOS / Linux 用户点这里</b></summary>

装好 Node 22.13+ 后，在项目目录里执行：

```bash
npm start
```

然后浏览器打开 <http://localhost:3737>；停止服务按 `Ctrl + C`。

</details>

---

## 🎬 第一次打开，先做这 4 件事

| 顺序 | 做什么 | 怎么做 |
| --- | --- | --- |
| 1 | **导入一本示例小说**（强烈建议） | 首屏「🧪 示例小说」区块 → 点「✨ 一键导入示例小说《雾都缝匠》」→ 再点「打开《雾都缝匠》」。它自带章节、角色、设定词条、长期记忆与事件账本，能让你立刻看懂每个页面是干什么的 |
| 2 | **逛一圈** | 左侧点「总览」看数据统计 → 「正文写作」点章节树里的任意一章，试着改几个字（会自动保存）→ 「小说设定」看剧情线 / 大纲 / 设定库 / 角色 / 长期记忆 |
| 3 | **建自己的作品** | 点左上角「📚 我的作品」回到初始页 → 右上角「新建作品」→ 填书名 → 进入后用「新建章节」按钮就能开写（建议先建一卷；新建章节的对话框里可以指定它属于哪一卷，不指定也能写，会显示为「未分卷」） |
| 4 | **（可选）接入 AI** | 想用 AI 写作 / 续写 / AI 生成大纲，再看「🤖 AI 功能配置」。这一步需要你自己准备模型服务的 API Key，**会产生费用**，不急 |

> 💡 示例小说随时可以删：在「我的作品」页的「🧪 示例小说」区块点「删除示例数据」即可，你自己的作品不受影响。

![我的作品页：右上角「新建作品」，下方「🧪 示例小说」区块可一键导入《雾都缝匠》](assets/screenshot-home.png)

---

## 📚 我该看哪份文档？

| 你的情况 | 直接看 |
| --- | --- |
| **第一次用，只想尽快跑起来** | 本文「🚀 快速开始」；卡住了看 **[docs/新手入门.md](docs/新手入门.md)**（逐步骤讲解 + 逐条排错） |
| 想先知道有哪些功能 | 本文「✨ 为什么是这套机制」 |
| 启动失败 / 报错看不懂 | 本文「🆘 新手常见问题」→ 详细版见 [docs/新手入门.md](docs/新手入门.md) |
| 想接 AI 写作 | 本文「🤖 AI 功能配置」 |
| 想知道每个版本改了什么 | [docs/CHANGELOG.md](docs/CHANGELOG.md) |
| 想改代码 / 了解 AI 内核与上下文装配 | [docs/ai-core.md](docs/ai-core.md)、上下文契约 [docs/context-contract.md](docs/context-contract.md) |
| 想跑验证 / 看验收口径 | `node .p1-baseline/verify-all.mjs`；说明见 [.p1-baseline/README.md](.p1-baseline/README.md) |
| 想参与开发 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 想找某份具体文档 | [docs/README.md](docs/README.md)（全部文档索引） |

> 🔗 **相关仓库**：本仓库是工坊主程序，创作插件源码内置在 [`harness-plugins/novel-writing/`](harness-plugins/novel-writing/)，
> 另有独立发布镜像 [bbaz123/novel-writing-plugin](https://github.com/bbaz123/novel-writing-plugin)。

---

## 📦 安装与运行（详细步骤）

### 第 0 步：环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows / macOS / Linux | Windows 可直接用仓库里的 `start-novel-studio.cmd` 一键启动 |
| Node.js | **22.13 或更高**（推荐 24 LTS） | 使用内置 `node:sqlite`，**不需要执行 `npm install`**。注意：22.5 ~ 22.12 里该模块仍需加 `--experimental-sqlite` 参数才能用，所以实际门槛是 22.13 |
| 浏览器 | Chrome / Edge / Firefox 等现代浏览器 | 界面是纯前端页面，无构建步骤 |
| 磁盘 | 约 50 MB（不含作品数据） | 作品数据库位于 `data/`，随使用增长 |

检查 Node 版本：

```bash
node -v      # 需要 v22.13.0 或更高（22.5 ~ 22.12 需额外参数，见「🆘 新手常见问题」）
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

1）准备一份 DeepSeek Harness（dsh）仓库（<https://github.com/deepseek-ai/deepseek-harness>），然后告诉工坊它在哪——**推荐在界面里填**：

```text
✨ AI 创作 → ⚙️ AI 设置 → 🛠 本地创作内核（dsh） → 填路径 → 保存路径
```

保存后立即生效，**不需要设环境变量、也不需要重启服务**；卡上会显示它在不在、构建好没有、按顺序找过哪几个位置。用环境变量也可以（适合脚本化/多实例）：

```bash
# Windows PowerShell
$env:NOVELSTUDIO_DSH_REPO = "C:\path\to\deepseek-harness"
npm start
```

2）安装创作插件。源码就在本仓库 `harness-plugins/novel-writing/`，独立发布仓库为 <https://github.com/bbaz123/novel-writing-plugin>：

```powershell
# 预演（不写任何文件）
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Profile novel -DryRun

# 安装 / 升级到专用 profile `novel`（novel-studio 后台任务用）
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Profile novel

# 卸载
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Profile novel -Uninstall
```

`-Profile` 省略时默认 `headless`。安装做三件事：① 把 GUI preset 复制到
`~/.dsh/.agent-presets/novel-writing/`；② 让目标 profile 在 `dsh.profile.bundles` 里列出
`novel-writing`，并在它的 `node_modules` 下建立指向本仓库的 **junction**——
**工坊仓库即唯一来源，没有副本**；③ 识别并清理旧版"区块合并"安装留下的痕迹（带备份）。

> 自 P0（专用运行时）起，插件不再以"区块合并"方式写进 profile 的 `cordis.patch.yml`，
> 也不再往 profile 目录复制 `novel-tools.mjs`。改完插件代码**立即生效**（走 junction），
> 不需要重跑安装。详见 `docs/ai-core.md` §六。

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

# 工具配置链离线测试（不连服务器、不碰你真实的 ~/.openviking 与 ~/.dsh）
node env-tools-test.mjs

# 接口回归：需先在 127.0.0.1:3738 起一个隔离实例
node api-test-suite.mjs

# 前端执行验证（最小 DOM 桩里真跑 public/app.js）
node frontend-test.mjs
```

---

### 卸载

程序是**绿色免安装**的：没有安装目录、没有注册表项、没有系统服务、没有后台常驻进程。

```bash
# 1）停掉服务：在服务窗口按 Ctrl+C（会先把数据落盘再退出）
# 2）需要的话先备份：整个项目里的 data/ 目录就是你的全部数据
# 3）直接删掉项目文件夹
```

- 装过桌面快捷方式的话，顺手删掉桌面那个图标即可
- **只想清空数据、保留程序**：关掉服务后删除 `data/` 目录，下次启动会自动重建空库

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
- 模型（下拉只有一个推荐项 `deepseek-flash`（DeepSeek-V4.1-Flash，能力最强、单价最低）；其它 OpenAI 兼容服务商的自定义模型名同样兼容）
  - ⚠️ **模型优先级：功能内置的模型参数 > 这里的 `model`**。功能内置分工由
    **`ai/policy.mjs` 单点控制**（P4 起；此前散落在 `public/app.js` 的 12 处硬编码 +
    `server.js` 的同名常量 + `harness.js` 的另一份强度白名单里）。前端经 `GET /api/ai/policy`
    取同一份策略。两个档位**都用 V4.1 Flash**，差别在思考强度：
    - `fast` = `deepseek-flash`，不额外指定强度 —— 提问/澄清、质检轮、入账整理、润色/扩写/细纲/性格校对、**章节正文成文**、批量生成、创作工作台三档；
    - `quality` = `deepseek-flash` + `reasoning_effort: high` —— 结果会喂给之后每一章的环节：AI 审稿、AI 修稿、**设定生成的成文轮**、AI 自动创建小说、长期记忆压缩。
      （2026-09-18 用户决定：这两档过去用「更贵的 `deepseek-v4-pro`」表达质量优先；V4 Pro 已是上一代，改为**同样的模型 + 更多思考预算**，意图不变、成本更低。改动理由与回滚方式写在 `ai/policy.mjs` 文件头。）
    - 因此**改这里的 `model` 不会影响上述功能**；该字段仅对未固定模型的功能生效（当前为连接测试，以及仅供 API 调用的 `/api/ai/generate_novel`）。要调整分工请改 `ai/policy.mjs`。
    - 改完可跑 `node .p1-baseline/verify-ai-branches.mjs` 确认没有绕过策略的散落字面量，
      `node .p1-baseline/test-policy-tiers.mjs` 确认两档模型/强度/超时没被改坏。
  - 已下线或已收敛的模型名不再出现在下拉框中：`deepseek-chat` / `deepseek-reasoner` 官方已于 2026-07-24 停止服务；`deepseek-v4-pro` 于 2026-09-18 并入 V4.1 Flash；`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 已由 V4.1 Flash 取代（旧名仍会被服务端路由到 V4.1 Flash）。**存量配置里前三个名字会在启动时自动改写为 `deepseek-flash`**（清单见 `ai/policy.mjs` 的 `LEGACY_MODEL_NAMES`）。
- 温度、最大 Token

### 2. 配置 DeepSeek Harness（可选但推荐）

本项目的 AI 创作 / 深度写作通过 `deepseek-harness`（dsh）执行。若未安装，AI 写作与自动创作可能不可用。

**推荐**：在界面里填一次即可（存本机数据库，重启后仍有效）——`✨ AI 创作 → ⚙️ AI 设置 → 🛠 本地创作内核（dsh）`。
同一张卡上还能看到：它实际用了哪个路径、这个路径是从哪来的、dsh 是否已构建、写作任务的 `DSH_HOME` 是哪。

也可以用环境变量指定 Harness **仓库**所在目录（推荐使用专属变量，避免与 dsh 官方的 `DSH_HOME` profile 目录语义冲突）：

```bash
# Windows PowerShell
$env:NOVELSTUDIO_DSH_REPO = "C:\path\to\deepseek-harness"
npm start

# macOS / Linux
export NOVELSTUDIO_DSH_REPO="/path/to/deepseek-harness"
npm start
```

路径解析顺序（**前者优先**）：`NOVELSTUDIO_DSH_REPO` 环境变量 → 界面里填的路径 → `DSH_HOME`（仅当该目录下存在 `package.json` 时才采用）→ 工坊仓库同级的 `deepseek-harness` 目录。在其它电脑上运行时请按实际路径设置。

> 也就是说：**环境变量优先于界面里填的路径**（脚本化/多实例场景下由 `NOVELSTUDIO_DSH_REPO` 说了算）；界面上的「本地创作内核」卡会如实标出当前用的是哪一层。

> 单轮短任务（润色 / 扩写 / 性格校对 / 细纲等）会优先走「AI 设置」里配置的 API 直连通道（秒级响应），只有需要调用创作内核（角色卡 / 世界观 / 红线）的任务才会经过 Harness 慢通道。

> ⚠️ **如果你手动设过 `DEEPSEEK_BASE_URL`**：dsh 0.1.7 起它的模型客户端走 **Messages API**，
> 该变量必须是 **Messages 兼容根**（官方根 `https://api.deepseek.com/anthropic`，客户端会在其后追加
> `/v1/messages`）。指向 **OpenAI 兼容**的第三方网关会让**慢通道**任务报
> `HTTP_404: DeepSeek Messages request failed`，而直连通道不受影响——这是最容易误判成
> 「工坊坏了」的一种配置错。**没设过这个变量就不用管**（默认走 dsh 自带的 `deepseek-official`）。

---

## 💻 使用

**日常写作**：在章节树里选一章，直接在编辑器里写，**自动保存**。切到三栏布局后，右侧参考面板常驻显示设定词条、角色、剧情线，以及「**AI 这次到底会看到什么**」的上下文预览（含语义召回命中与相关度）。

**用 AI 写作**：工具栏的 `✍️ AI 写作` 会先弹**需求确认框**（含「直接开始」），**确认后才发起付费调用**，不会误触扣费。AI 一次只问一个问题，问清楚之后才动笔；产出的事件与记忆先落成**提案**，你勾选才入账。

**HTTP API**：界面是本地 HTTP API 之上的一层薄客户端，因此可以脚本化：

```bash
# 健康检查
curl http://localhost:3737/api/novel/ping

# 导入示例小说（可选；界面上那个按钮做的是同一件事）
curl -X POST http://localhost:3737/api/demo/install \
  -H 'Content-Type: application/json' -d '{}'

# 查看某个作品的创作上下文（也就是「模型这次会收到什么」）
curl 'http://localhost:3737/api/novel/context?work_id=1'
```

> 写请求只允许**同源的本地调用**：服务端会校验 `Origin` / `Host`，并且只监听 `127.0.0.1`——这同时也挡住了 DNS rebinding。

---

## 🖼️ 界面截图

![正文写作：左侧章节树、中间富文本编辑器、右侧设定参考面板](assets/screenshot-writing.png)

![小说设定 · 角色：基础档案、当前状态与人物关系](assets/screenshot-settings-characters.png)

![总览：章节、设定词条、角色与剧情线的一屏统计](assets/screenshot-overview.png)

> 💡 以上截图都取自仓库内一键导入的示例小说《雾都缝匠》。
> （`assets/preview.png` 是应用图标的多尺寸预览，用于生成桌面快捷方式图标，**不是**界面截图。）

打开后是一屏三栏的写作台：

- **左侧导航**：`📚 我的作品`（管理多部作品）、`✨ AI 创作`（用一段描述让 AI 从零生成新书）；进入某部作品后是 `总览 / 正文写作 / 小说设定 / AI创造板块`，下方还有常驻的 `🐞 运行追踪` 与 `🧾 日志`
- **中间正文编辑器**：左侧章节树选章，右侧写正文——富文本排版、自动保存、实时字数统计，工具栏一键调起 `✍️ AI 写作`
- **右侧参考面板**：随手查本章涉及的设定词条、角色卡、剧情线，以及「AI 这次到底看到了什么」的上下文预览（含语义召回命中与相关度）

---

## 🏗️ 架构

### 一次成文请求的数据流（架构）

```text
你的作品数据（SQLite）
        │
        ▼
ai/context/layers.mjs    14 层规格（另 1 层故事状态为门控可选）：每层声明来源 / 时间视角 / 知识范围 / 选择方式 / 已知缺口
        │                 （作品 · 大纲 · 长期记忆 · 语义召回 · 事件账本 · 未闭合伏笔 · 当前场景 ·
        │                  本章蓝图 · 前文衔接 · 出场角色卡 · 人物关系 · 世界观 · 设定词条 · 写作红线）
        ▼
ai/context/assembler.mjs 唯一装配器：按预算裁剪；**凡裁剪必可查回**（每层给出 tool_hint）
        ▼
ai/context/integrity.mjs 身份与完整性：context_id（内容哈希）+ context_request_id（本次装配）
        │                 清单与真正发给模型的文字必须逐字节对得上，不合格只响亮记录、不拦截
        ▼
harness.js → dsh 会话     模型档位与思考强度的唯一来源在 ai/policy.mjs（0 处绕过）
        ▼
成文 / 提案                事件与记忆先落「提案」，你勾选后才入账
        ▼
ai/continuity-guard.mjs   成文后确定性核对：未闭合伏笔 / 角色状态 / 事件账本 / 命名实体 / 本章边界
```

### 目录地图

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
├── assets/             # 界面截图（README 用）+ 图标资源（novel-studio.ico 快捷方式图标、preview.png 图标多尺寸预览）
├── novel-studio-icon.ps1 # 图标生成脚本（渲染 preview / 打包 ico / 应用到桌面快捷方式）
├── demo-data.json      # 示例小说《雾都缝匠》演示数据（“我的作品”页一键导入，可选）
├── harness-plugins/novel-writing/   # 内置创作插件（dsh 侧唯一来源；发布镜像见 novel-writing-plugin 仓库）
│   ├── package.json / cordis.patch.yml # bundle 声明与补丁层（人设 + novel_* 工具 + 瘦身）
│   ├── novel-tools.mjs              # novel_* 工具集（后台任务与 GUI preset 同源）
│   ├── agent.cordis.yml / preset.yml# GUI 会话 preset
│   ├── install-profile.mjs          # profile 接线器（bundles + junction + 旧痕迹清理）
│   ├── install.ps1                  # 安装入口（-Profile/-DryRun/-Uninstall）
│   ├── plugin.json                  # 清单：工具/端点/契约
│   ├── test/smoke.mjs               # 端到端冒烟测试（node:test 风格断言）
│   ├── ENGINE.md / NATIVE_PLUGIN_GUIDE.md / README.md
│   └── headless-cordis.patch.yml    # 【已弃用】旧区块合并片段，仅为对照保留
├── ai/                 # AI 内核（见 docs/ai-core.md）
│   ├── policy.mjs      # 模型档位与思考强度的唯一来源
│   └── context/        # 上下文装配内核：layers.mjs（层规格）+ assembler.mjs（装配器）
├── .p1-baseline/       # 契约基线、压力数据与验证工具（verify-all.mjs 一键跑全部）
├── .p0-recon/          # dsh profile 侧的证据与工具（组合树对账、spawn 路径验证）
├── package.json
├── LICENSE             # 本项目 MIT
├── THIRD-PARTY-NOTICES.md  # 第三方组件与资产清单（不在 MIT 覆盖范围内）
├── start-novel-studio.cmd
├── create-desktop-shortcut.ps1
└── data/               # 本地数据库（不会上传到 Git）
```

---

## ⚙️ 配置项（环境变量）

全部可选。**只手动写作的话，一个都不需要设**；下面这些只在多实例、隔离测试、或想调整默认行为时才用。

启动：

- `PORT` —— 服务端口，默认 `3737`
- `NOVELSTUDIO_DATA_DIR` —— 数据目录，默认项目内的 `data/`（多开或隔离测试时用）

AI / 创作内核：

- `NOVELSTUDIO_DSH_REPO` —— DeepSeek Harness 仓库所在目录（**优先于界面里填的路径**）
- `NOVELSTUDIO_DSH_PROFILE` —— 写作任务使用的 dsh profile，默认 `novel`
- `NOVELSTUDIO_DSH_LAUNCH` —— `source` / `built`，强制走源码或预构建产物（默认自动判断：产物存在且不比源码旧才用）
- `NOVELSTUDIO_DSH_HOME` —— 给写作任务指定一份专用 dsh home（进阶）
- dsh 热备池（`ai/harness-pool.mjs`）—— **尚未接线到生产路径**（没有环境变量开关，`harness.js` 仍走"每任务一个子进程"）。冷启动收益现在来自"优先用预构建产物"，不是热备池；接线前需先测收益
- `NOVELSTUDIO_CONTEXT_CACHE_TTL_MS` —— 上下文装配缓存 TTL，默认 10 分钟（只作兜底：索引一旦完成缓存立刻失效）

记忆库与护栏：

- `NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1` —— 对「从未出场的实体被提及」也严格拒绝（默认只记日志放行）
- `NOVELSTUDIO_COMPRESS_MIN_COVERAGE` —— 压缩覆盖率下限（0~1），用于放宽护栏
- `NOVELSTUDIO_OV_DISABLED=1` —— 整体停用 OpenViking 集成（冒烟 / 隔离环境）
- `NOVELSTUDIO_OV_AUTOINDEX=0` —— 关闭启动时的自动建索引
- `NOVELSTUDIO_OPENVIKING_PEER_ID` —— 覆盖写作任务归属的记忆库 peer

运行追踪：

- `NOVELSTUDIO_TRACE_KEEP` —— 保留最近多少个录制会话文件，默认 20
- `NOVELSTUDIO_TRACE_MAX_NODES` —— 单次操作最多采集多少个节点，默认 2000
- `NOVELSTUDIO_TRACE_IDLE_MS` —— 前端心跳丢失后多久自动停止录制，默认 20 秒

> 另有一组 `NOVELSTUDIO_BASE_URL` / `_WORK_ID` / `_CHAPTER_ID` / `_MODE` / `_PROPOSE_MODE`：
> 那是**工坊下发给 dsh 子进程的**任务上下文，不是给你手动设的配置项（见 `server.js` 的 spawn 段）。

```bash
# 例：换端口 + 换数据目录（Windows PowerShell）
$env:PORT=3738; $env:NOVELSTUDIO_DATA_DIR="D:\novel-data"; npm start
```

---

## 🔒 数据与隐私

- 所有数据保存在本机：`novel-studio/data/novel.db`；运行日志位于 `data/logs/`（14 天自动清理）
- 运行追踪的录制明细位于 `data/debug/trace-*.jsonl`（默认保留最近 20 个会话，可在追踪页一键清空）；**其中不包含小说正文与提示词正文**，只含代码位置、耗时与长度等形状信息
- API Key 也只保存在本地 SQLite 数据库中
- `data/` 目录（含数据库备份目录 `data/backup-*` 与 `data/debug/`）已被 `.gitignore` 排除，**不会随仓库上传**
- 首次启动时如果数据库不存在，程序会自动创建所需的表结构

---

## 🗺️ Roadmap

这一节只列**能在仓库里核对到现状**的条目；完整的待决清单与逐项代价见
[docs/pending-decisions.md](docs/pending-decisions.md) 与最近的审查报告。

- ~~声明开源许可证~~ → **已定案：MIT**（见 [LICENSE](LICENSE)）
- ~~接入 CI~~ → **已落地**：`.github/workflows/ci.yml`（离线 50 条 × Windows/Linux + 依赖下限 22.15 + 活实例 2 条）。
  每个 job 先打**平台事实**（platform/release/arch/node/路径分隔符）；ubuntu 两格本机没有 Linux 可预演，
  首次真红要**修脚本**，不许整格 `continue-on-error`（确需临时放行只对该 step 并注明）
- **跨平台一键启动**：目前 `start-novel-studio.cmd` 只服务 Windows；macOS / Linux 需要 `npm start`
- **可选的局域网访问开关**：当前服务只监听 `127.0.0.1`，想在平板或手机上写作得手动改 `server.js`
- **更多导出格式**：现已支持整书 TXT / 整书 Markdown / 单章 TXT；EPUB / DOCX 尚未支持

---

## 🤝 参与贡献

这个项目目前由作者一个人维护，**Issue 与 PR 都欢迎**。动手之前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)，要点只有几条：

- **提问、想法、"这个怎么用"**：请走 [Discussions](https://github.com/bbaz123/novel-studio/discussions)，不要开 issue
- **Bug**：[Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml) 会要你的 Node 版本、操作系统、复现步骤与报错原文
- **先开 issue 再写大 PR**：避免几十行改动做完才发现方向不对
- **改完先跑现状**：`node .p1-baseline/verify-all.mjs`（离线跑批；需要活实例或外部仓库的检查会明确标成「跳过」，**跳过不等于通过**）
- **不要提交 `data/`**：里面是你的作品与 API Key（已在 `.gitignore` 内）
- **代码风格**：零 npm 依赖、纯 ESM、中文注释解释**为什么**这么做，而不是复述代码在做什么
- **`docs/` 里的历史报告描述的是当时的代码**：行号可能已过时，找代码请按符号名

---

## 📄 License

**MIT**（见 [LICENSE](LICENSE)）——可自由使用、修改、分发、商用，只需保留版权与许可声明。

选 MIT 的理由（一句话）：本项目的价值在「能长期自己掌控的写作工具」而不在许可限制；
与它协作的 DeepSeek Harness 本身也是 MIT，保持一致最省沟通成本。想改回更严格的许可，
改 `LICENSE` 一个文件即可（历史提交不受影响）。

**第三方资产**（不在 MIT 覆盖范围内，各自遵循上游条款，完整清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）：

- `vendor/models/bge-small-zh-v1.5-f16.gguf` —— 上游模型 `BAAI/bge-small-zh-v1.5`
  （模型卡标注 MIT），GGUF 转换件来自 `CompendiumLabs/bge-small-zh-v1.5-gguf`；
  本仓库**原样**随源码分发（不改字节），SHA256 见 [vendor/README.md](vendor/README.md)
- DeepSeek Harness（`dsh`）与 OpenViking 是**独立项目**，不包含在本仓库内；许可与版本核验记录见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（dsh：MIT，本机 0.1.7-rc.1；OpenViking：以本机实际安装版本为准，当前上游主项目 AGPL-3.0）

---

## 🙏 致谢

本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 AI 能力开发；世界观与角色处理的设计思路借鉴了 [SillyTavern](https://github.com/SillyTavern/SillyTavern)。

工坊首页的「**🙏 借鉴与致谢**」页列出了**实际用到的**每一个开源组件与设计参考来源，以及对应的许可核验记录——只写真实关系，不显示会过期的人气计数，也不暗示官方合作或背书。

第三方资产（`vendor/models/*.gguf` 等）遵循其上游许可，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [vendor/README.md](vendor/README.md)。

---

## 📝 更新记录

### 🛠️ 最近更新（2026-10-08 · **v1.1.6** 实验版：叙事结构机械感）

**这就是当前版本。** 上一版解决的是"改字的时候别改坏事实"；这一版解决的是**生成端为什么会把结构写成机械的**。
作者对第一章《觉醒日》的结构层审稿结论是一句话：**「AI 太认真地把所有事情都交代清楚了」**——
不是词汇层面的 AI 味（没有"嘴角勾起一抹"这类典型 AI 词），而是叙事结构层面的机械感：
同类流程完整复现、时间轴过密、群众反应换着说法重复、主角被写成摄像机。

- **P0 根因（一处自相矛盾的提示词）**：`buildAIWritingProsePrompt` 里写着"把蓝图里的场面写完整：**每个场面必须有**明确地点、出场人物、身体动作和冲突/转折，再在场面内部补环境、动作、心理、对话与节奏"，而写作策略源里同时写着 `avoid_repeated_full_mechanism`（同一机制不要完整复现第二遍）。模型只能选前者——这就是"觉醒检测流程完整演示 4 次"的直接来源。现改为**功能驱动**：关键场面展开（发生了什么／谁做了什么选择／什么变了），过渡场面允许略写跳过，同类流程第二次只写结果差异与人物反应，**第一次要写足**
- **`story-shape`：把结构层从"给模型的话"变成"可复算的事实"**（`ai/editing/rules.mjs` v1.4.0，默认关闭、只报告）。四类测量＋判据：① 同形流程簇（"机制动作＋结果呈现"同段成立才算，**假设句与梦境不算**）；② 时间锚点（**绑定了钟点/相对日的时段词才算推进**——"你从早上念到现在"不算，"一上午过去"这类时长不算）；③ 匿名群众反应段（有新具名主体、或是对话段都不算）；④ 非转播上下文里的镜头调度词（**真的处在直播/转播视角时镜头词是合法的**）。另有 `scanned.style_shape` 常驻测量值，**与能力开关无关**，界面可直接显示
- **`PROTECTION_RULES` 第 10 条**：同类机制只完整演示一次，但**第一次那次必须保留**——首展是读者学会这套规则的唯一机会，压掉它后面第二次的"差异"就没有参照了。同一条取舍也写进了修稿补丁提示词（第 6 条）
- **写作策略源补三条**（`ai/writing/policy.mjs` → 2026-10-08.2）：`first_showing_stays_complete`、`prefer_progressive_revelation`（世界观随事件渐进揭示，不集中说明）、`prefer_result_over_repeated_process`，以及诊断项 `diag_timeline_density`。方案原列的其余诊断与偏好**已在仓库中**，故不新建——同一判据两份文本必然漂移
- **`/api/novel/consistency` 追加 `checklist.style_diagnosis`**（**只追加字段**，现有字段与输出契约一字未动）：自己显式打开 `story-shape` 跑一次，因此**不依赖作者是否启用了该能力**；`novel_consistency` 工具把它渲染成第 ⑨ 项自检＋结构诊断区块，模型不必自己重新数段号
- **人设只加一条总原则**（`agent.cordis.yml`）：**不要为了证明读者已经理解的事实，再换一种方式解释第二遍。一次强证据成立之后，后续默认只写变化。** 控制规则数量，不铺几十条细则
- **能力边界（如实说）**：本章**可复算**的"同形流程再现"只有 **2 组**（不是目测的 4 次完整复现），时间锚点 4–5 个、匿名群众反应 1 段、镜头越界 0 段——即 S1/S3/S5 在本章是**倾向**而不是硬性缺陷。判据因此**保持静默**（零误报纪律：未命中不表态），这是刻意的取舍而非漏检；"主视角摄像机化"同样被量尺判为未命中（本章主动动作 12 段 > 看/听 5 段）
- **验证**（本机 · 零计费）：新增 `probe-story-shape-20261008.mjs` **41/41**（语料是作者真实的两版正文，含**正例／负例／静默姿态**三类断言），校准探针留下每个阈值的实测来源；编辑规则隔离实例含新增派生护栏 `C0c`。本轮在真实语料上抓出并修掉**六处判据缺陷**（时长守卫误删真锚点、`vagueOnlyRe` 定义了却从未使用、同段两时间词误判过密、镜头上下文只看前一段、`MEDIA_CONTEXT_RE` 自我实现、群众反应按动词分簇导致正例漏报），留痕见 [docs/deai-source-fix-round5-20261008.md](docs/deai-source-fix-round5-20261008.md)

### 🛠️ 之前更新（2026-10-08 · **v1.1.5** 实验版：一致性判据 + 允许人味）

**当时是当前版本。** 起点是作者拿同一章「审稿前 / 审稿后」两版正文做的对比复核。结论是
**六类问题没有一类是"模型写坏了"，全部是源码里缺拦截或缺规则**。更根本的一条是——
保护规则（第 2 条明文保护"数字与专有名词"）**只被 `task:'write'` 的上下文层使用**，
而**润色与改稿这两条真正会改字的通道上，从来没有下发过保护规则**。

- **事实锁 `fact_lock_conflict`（硬拦，`public/patch-safety.js` v1.1.0）**：同一实体章内两个编号 / 同一编号两个主人 / 这条补丁让**有主人的编号**从章内整体消失 → 该补丁不进差异稿，两处冲突位置并排列出。作者复核稿里 `1738 → 1736`（与 `1736号王磊` 撞号）现在拦得住
- **只报告三条**：`scene_bridge`、`cross_paragraph_duplicate`（跨 ≥3 段整句重复，**与能力开关无关**）、`percent_sum_mismatch`（容差 0.5 个百分点，含"万分之一"这类稀有度写法）
- **三项默认关闭的测量能力**（`ai/editing/rules.mjs` v1.3.0）：`number-lock`、`scene-bridge`、`promise-identity`；`scanned.promise` 另外无论开关都给出 `system_showcase_count` / `year` 测量值
- **保护规则第 8 条（数字锁）与第 9 条（转场桥）+ 真正的接线**：注入润色与两条修稿提示词，与 `edit_rules_enabled` 无关（保真底线不是创作偏好）
- **允许人味**（作者要求）：`allow_human_slack`（成文/扩写）+ `protect_human_slack`（修稿），刻意不给配额——配额化正是 AI 味的结构性来源

### 🛠️ 之前更新（2026-10-07 · **v1.1.4** 实验版：Safe Editing——修稿安全门禁）

**这就是当前版本。** 第一轮解决"流程模板"（机械补字 / 场景与系统配额 / 三态质检），第二轮把重点转到
"为什么这一句值得出现在这里"；这一轮补上**改稿落地这一端**：修稿补丁以前只问"这条改得动吗"（能不能
唯一定位），从不问"这条该不该自动应用"。于是同一章真实发生了四类误伤——删掉承担物件来历的句子
（后文凭空出现物件）、删掉后文回指所依赖的首次人物主体、删掉场景来源（读者不知道在看现场还是屏幕）、
为解释一句排队顺手新增一整套设定。本轮加一道**确定性安全门禁**：只拦命中的高风险补丁，其余照旧应用。

- **新增 `public/patch-safety.js`**（UMD 纯函数模块，浏览器与 Node 测试共用）：三条纪律——① 判据只认能逐字指出来的证据；② 未命中不表态；③ **逐条粒度**（命中的那条不进差异稿，同批其余补丁照旧应用）
- **五个硬拦结论码**：`protected_content`（作者指定保护句被删）、`story_fact`（改后新出现本章从未有过的正式事实形态：等级 / 地名机构 / 拉丁编号区 / 编号日期 / 新人物名，或段落长出一倍且多 60 字以上）、`object_provenance`（被删词面在后文以回指式用法再次出现、且删除点前无任何残留、也没被重新引入）、`reference_anchor`（被删的人物 / 主体名词在后 3 段仍被代词承接、且已无任何人称锚点）、`scene_anchor`（被删的场景来源词在后 3 段仍被代词或地名承接）
- **`causal_bridge_break` 只报告不拦**：原因连词（`因为 / 为了`）被删、后 4 段仍有结果连词承接——这类连词太常见，硬拦会误伤正常压缩
- **分级放行**：`wording`（删掉的只是描写）与 `local_structure`（删掉带动作 / 对白 / 主体的句子）都放行；`story_fact` 一律不自动应用
- **失败姿态是放行**：门禁模块缺失或抛错绝不阻塞作者修稿，但会在差异预览里写明 `safety_unavailable`（本次没有任何补丁被拦截）——静默降级才是真正危险的失败
- **整章重写兜底路径**（没有补丁可拦）改用 Diff-aware 修后核验（`patchSafetyVerify`，只报告），结果同样进差异预览
- **本批不改模型输出契约**：补丁 JSON 形状与提示词字段一字未动；也不改"作者点「合并到正文」就必须写进去"的既有裁决

**同批一并交付：**

- **章节蓝图历史（每章最多两份）**：新增 `chapter_blueprints` 表，蓝图从"一章一列、覆盖式写入"改成独立记录——作者反复「重新规划」时可回退上一版（此前旧蓝图被直接覆盖，写完正文后那唯一一份还会被喂给模型，规划新章时拿上一章旧计划反问作者）。`chapters.blueprint_json` 保留为"最新那一份"的镜像（上下文装配 / 检索索引 / 一致性核对读的还是它，链路一行不改），上限 2 份、超限自动丢最旧；**AI 写回本章正文时整章蓝图连同镜像一并删除**。新增 `GET` / `DELETE /api/novel/chapter_blueprints`，`PUT /novel/chapter_blueprint` 向后兼容地追加返回 `blueprint_id / saved_count / limit`
- **「合并到正文」改为强制写入**：删除"正文在差异预览之后被改过 / 读不到就拒绝合并"的闸门（空正文章节点多少次都是同一句拒绝）。新契约：**作者点「合并到正文」，就必须写进正文**；正文指纹退化为观测，只用于告知与留痕（`review_merge_overwrite`），被覆盖的那一版由服务端存进本章历史版本（可回退）。理由：拒绝并不比覆盖更安全——拒绝会把作者逼去手工把预览段落抄进编辑器，那反而不可回退
- **发布面**：Host Contract **1.21.0**（新增 `chapter_blueprints`，73 张表；迁移幂等与空库建表纳入离线门禁）

**验证**（本机 · 零计费）：离线检查 **50/50**、前端执行验证 **464 条 ALL PASS**、Host Contract 契约测试 **28/0**（1.21.0）、插件冒烟 **39 组**全过、接口套件 **192/196 通过 / 0 失败 / 4 跳过**。

### 🛠️ 最近更新（2026-10-06 · **v1.1.3** 实验版：去 AI 味第二批——诊断层）

**这就是当前版本。** 第一轮解决的是"流程模板"（机械补字 / 场景与系统配额 / 三态质检）；这一轮按第二轮验收
结论，把重点从"继续加反 AI 提示词"转到 **"为什么这一句值得出现在这里"** —— 新增规则全部是**诊断项**：
只提示疑点、不设配额、不设禁词，作用阶段限定在审稿侧，不会变成新的正文模板。

- **信息饱和度（`diag_information_saturation`）**：某项信息已被强证据建立（"楼旧"由"六层无电梯 + 外墙掉瓷砖"成立）
  之后，还在用功能相同的细节继续证明（接连多个坏灯）——只提示，**不规定同一信息最多证明几次**（高潮 / 恐怖 / 压迫 / 喜剧都可能故意累积）
- **功能重复（`diag_functional_redundancy`）**：句子不同、但承担完全相同的叙事功能（有人摇头 / 有人议论 / 有人惋惜都在证明"大家觉得可惜"）——
  按功能判断，不再只查重复句式
- **否定式自我解释（`diag_negative_explanation`）**："没说 / 没问 / 没解释 / 没有别的 / 没再看"式短句连续承担
  "作者不直接总结、但仍在解释人物心理"的功能时，只在明显重复处提示，不设禁词
- **疑似伏笔走 `deferred`（待后续核验）**：质检与审稿报告新增 `deferred` 通道——疑似伏笔、未知等级、暂未解释的异常
  **不计入 verdict、不写进 issues、不进入修稿清单**，也不会被审稿器擅自删掉；成文结果弹窗与审稿弹窗各有独立分区展示
- **细节功能密度 / 叙述资源预算**：动笔前先回答"这个场景值得把叙述资源花在哪里"、这个细节除了当前作用有没有第二作用；
  **不设细节数量、字数比例或固定配比**（`scene_detail_budget` / `diag_detail_function_density`）
- **最小改动修稿 + 保护高辨识度段落（`protect_high_identity`）**：修稿优先删 / 合并低价值重复、去掉含义已由动作或对白
  表达之后的总结句；不得改写母亲从安慰转到"饭吃了没有"、父亲转账附言"吃饭"、王磊与岳宸炎的应答、系统落回早自习这类承担多重功能的选择
- **插件侧同步**：`novel_consistency` 自检新增三问（信息饱和度 / 功能重复 / 否定式解释）与"疑似伏笔标 deferred"；
  `agent.cordis.yml` 与 `cordis.patch.yml` 两处人设补上"每一句为什么值得出现在这里"与"修稿最小改动"；创作插件 **0.17.0**（三处版本一致）
- **策略源版本**：`ai/writing/policy.mjs` → `2026-10-06.2`（19 条规则 = 7 条偏好 + 12 条诊断）

### 🛠️ 最近更新（2026-10-06 · **v1.1.2** 实验版：去 AI 味第一批 P0）

**这就是当前版本。** 以「去除 AI 味」为第一准则的第一批改造：把那些会把文字推向**工整填充**的规则
（按字数机械补字、按配额数场景、质检悄悄放行）从生成链路里拿掉，并把写作偏好收敛到**单一策略源**。

- **停止机械补字**：删除章尾「不足目标字数就自动续写」的循环与续写提示词（交互与批量两条路径都删）；
  篇幅改为**只诊断**（`ok` / `short_but_complete` / `missing_content`），不再驱动生成——剧情完整而篇幅偏短
  是正常结果，不会再把已经成立的章尾继续写下去
- **质检严格三态 `pass / issues / unknown`**：空结果、无证据的问题、覆盖不全、判不出来的结论一律 `unknown`，
  不再静默当成「通过」；顺带修掉一处会让直连分支抛 `verdict is not defined` 的作用域缺陷
- **删除全局硬配额**：网页蓝图 / 成文 / 质检提示、插件 `novel_blueprint` 与自检清单、验收清单里的
  「场景 3～5 个」「系统 5～15 次」全部移除；新增静态护栏（`.p1-baseline/verify-plugin-tools.mjs`），
  再出现配额或「自动续写补足」措辞即判红
- **统一策略源**：新增 `ai/writing/`（真源 `policy.mjs` / 阶段 `scopes.mjs` / 编译 `compile.mjs`）与
  `GET /api/ai/writing-policy`；规则分 **事实（fact）/ 偏好（preference）/ 诊断（diagnostic）** 三类——
  诊断项只提示疑点，不得变成正文禁令。前端优先用服务端已编译分区，本地兜底与真源逐条一致（防漂移）
- **插件人设同步**：`agent.cordis.yml` 与 `cordis.patch.yml` 两处都改成「目标字数不是配额、剧情完整即按
  已成立章尾收笔、场面数量按需、允许略写 / 跳过 / 沉默」；`novel_consistency` 明确篇幅与场面密度不作为一致性冲突项
- **发布面**：创作插件 **0.16.0**（26 个 `novel_*` 工具 / 75 条端点声明，三处版本一致）、Host Contract **1.20.0**

**验证**：离线检查 **50/50**（零计费）、前端执行验证 **ALL PASS**、插件冒烟 **39 组**全过、
接口套件 **192/196 通过 / 0 失败 / 4 跳过**。

## ⚠️ 注意事项

- 请勿将 `data/novel.db` 直接分享或上传，其中可能包含你的 API Key 与作品内容
- AI 请求会发送到你配置的模型服务商；如使用云端服务，请注意敏感信息
- 若修改了 `server.js` 或 `db.js`，重启服务后生效
- 本项目基于 DeepSeek Harness（dsh）的 AI 能力开发，有问题请直接询问 dsh
- 应用本体仓库：<https://github.com/bbaz123/novel-studio>
- 创作插件仓库（发布镜像）：<https://github.com/bbaz123/novel-writing-plugin>
- 借鉴开源项目：SillyTavern，利用其世界观等特色加深 AI 写作能力（相关实现见工坊首页「🙏 借鉴与致谢」，含许可核验记录）

---

## 🧭 界面导航速览

| 入口 | 说明 |
| --- | --- |
| 我的作品 | 未进入作品时默认显示，管理所有小说项目 |
| ✨ AI 创作 | 未进入作品时显示：AI 自动创建小说 / 创作工作台 / 创作任务历史 / AI 设置 |
| 总览 | 当前作品的章节数、设定数、角色数、剧情线数 |
| 正文写作 | 选择章节并写作，支持 AI 写作与富文本排版 |
| 小说设定 | 剧情线 / 大纲 / 设定库 / 角色 / 长期记忆 |
| AI创造板块 | 进入作品后显示：AI 设置 / 创作上下文 |
| 🐞 运行追踪 | 作品内外均可访问：录制开关 + 按操作分组的调用链、Token 汇总、筛选、历史录制回看与导出 |
| 🧾 日志 | 作品内外均可访问：统一日志系统的错误/慢操作/进程异常记录 |

> 顶栏常驻「🐞 运行追踪」按钮可直接开/关录制，不必先进入追踪页；录制中按钮显示「● 录制中」。

---

## 🆘 新手常见问题（先看这里）

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 双击 `start-novel-studio.cmd` 后浏览器打不开，或提示「无法访问此网站」 | 服务还没启动完，或启动失败已退出 | 等 5 秒刷新页面；仍打不开，就看那个黑色服务窗口里的报错，对照下面几行 |
| 服务窗口一闪就没了，或提示 `Node.js 22+ is required` | 没装 Node.js，或版本太旧 | 到 <https://nodejs.org> 装 LTS 版后重试 |
| 报错里出现 `node:sqlite`（如 `No such built-in module: node:sqlite`，或提示需要 `--experimental-sqlite`） | Node.js 版本是 22.5 ~ 22.12：这个区间里 `node:sqlite` 还需要额外的 `--experimental-sqlite` 启动参数 | 升级到 **22.13 或更高**（推荐 24 LTS）。官方版本说明：v22.13.0 起该模块不再需要此参数 |
| 报错 `listen EADDRINUSE: address already in use 127.0.0.1:3737` 然后窗口退出 | 3737 端口被别的程序占用了 | 换端口启动：`$env:PORT=3738; npm start`（PowerShell）或 `PORT=3738 npm start`（macOS/Linux）；想知道谁占用了就执行 `netstat -ano`，在输出里找结尾是 3737 的那一行，记下它的进程号（PID）去任务管理器结束 |
| 想换端口 / 换数据目录 | 默认端口 3737，数据在项目里的 `data/` | 用 `PORT=3738` 换端口；用 `NOVELSTUDIO_DATA_DIR="D:\novel-data"` 换数据目录（多开或隔离测试时用） |
| 需要联网吗？要花钱吗？ | — | **手动写作完全不联网、零费用**；只有使用 AI 功能时才会请求你配置的模型服务商并产生费用 |
| 我的作品数据在哪？怎么备份？ | 全部数据都在项目里的 `data/` 目录 | 数据库是 `data/novel.db`（含全部作品与 API Key）。备份请**先关掉服务、再复制整个 `data` 文件夹**——数据库启用了 WAL 模式，只拷 `novel.db` 会漏掉最近的写入（它含密钥，别发给别人） |
| 怎么彻底卸载？ | 程序是绿色免安装的 | 删掉整个项目文件夹即可，系统里不会有残留 |
| 能在手机或另一台电脑上打开吗？ | 服务只监听 `127.0.0.1` | 默认不能。确实需要局域网访问，得自行修改 `server.js` 的监听地址（属进阶改动） |
| AI 任务报 `HTTP_404: DeepSeek Messages request failed`（慢通道 / 深度写作） | 你手动设的 `DEEPSEEK_BASE_URL` 指向了 **OpenAI 兼容**的地址，而 dsh 0.1.7 起走 **Messages API** | 把它改成 Messages 兼容根（官方：`https://api.deepseek.com/anthropic`），或**直接清掉这个变量**用 dsh 自带配置。详见「配置 DeepSeek Harness」一节的提示 |

---

## 🧩 进阶功能（可选 · 不影响手动写作）

下面三节是给「想接 AI 写作」或「想深挖实现」的人看的，**新手可以整段跳过**：
共享记忆的语义召回、统一日志系统、运行追踪（把界面上的每次操作录成可回看的调用链）。

---

## 🧠 OpenViking 共享记忆（语义召回 · v0.9.0）

工坊与 OpenViking 共享同一个记忆库：六类小说数据（章节正文 / 长期记忆 / 事件账本与伏笔 / 设定词条 / 角色卡 / 大纲剧情线）会自动渲染成 Markdown 写入 OpenViking（`user/default/resources/novel-studio/<作品id>/`），由它的本地 bge Embedding（512 维）向量化，不额外占用一套模型与向量库。

> 定位说明：OpenViking 是**派生投影 / 语义检索**后端——正式正文、作者维护的长期记忆与 Canon Story State 仍以工坊宿主数据为准；DSH 会话记忆、作品资源投影与共享资料库是三条独立数据链，只是共用同一个记忆库实例提供跨会话与跨作品召回。

- **语义召回层**：AI 写作上下文装配新增「相关记忆检索（语义召回）」层——写第 N 章时按当前章节/蓝图/最近事件语义召回全库相关片段（top 8、阈值 0.3、预算 1400 字），正文 AI 写作提示词（蓝图/成文/续写）同样注入召回结果；可在写作页参考面板「上下文」页签预览命中与相关度，并可一键开关。
- **共享资料库（跨作品参考资料）**：跨作品共用的写作资料（方法 / 素材 / 范例）。把作者显式指定的目录扫描成 **dry-run 计划**（`.md`/`.txt` 白名单、单文件 ≤2MB、单批 ≤500 篇、不跟随符号链接、严格 UTF-8），确认后才写入共享资料根 `user/default/resources/novel-studio-library/<分类>/<slug>.md`，由同一个 OpenViking 本地向量化；作品打开开关后，写作上下文新增门控层「参考资料（非本书事实）」（top-4、阈值 0.40、单条 300 字、独立预算 1200 字），模型可用 `novel_library` 按关键词/分类把被预算裁掉的原文查回。资料**永不 canon**——只作参考，不进事实 / 事件 / 角色知识；开关默认关闭、逐作品开启，未打开的作品装配与接入前逐字节一致；导入 / 删除 / 开关都是作者动作，模型侧一律拒绝。（界面入口：侧栏「📎 资料库」页——资料列表与分类 / 关键词检索 / 导入两段式（扫描预览 → 确认导入）/ 按行读原文 / 按作品开关 / 标记缺失与确认删除；不喜欢用界面时端点仍可直接调用。）
- **增量同步**：保存/删除章节、词条、角色、记忆、事件等会自动防抖同步到记忆库（2s 合并）；服务器离线时进本地 pending 队列自动重放；`POST /api/novel/semantic_index` 可全量重建索引。
- **dsh 双通道共享**：GUI dsh（web profile）与工坊后台 headless dsh 都安装 `@openviking/dsh-memory-plugin`，写作任务会话自动采集进同一记忆库（跨会话可召回）；`harness.js` 会把 headless 任务归属到工坊 peer（`OPENVIKING_PEER_ID`，可用 `NOVELSTUDIO_OPENVIKING_PEER_ID` 覆盖）。
- **检索语义化**：全局搜索与 `novel_lookup` 叠加语义结果（`/api/search` 返回 `semantic.hits`）。
- **环境变量**：`NOVELSTUDIO_OV_DISABLED=1` 整体停用集成（冒烟测试/隔离环境）；`NOVELSTUDIO_OV_AUTOINDEX=0` 关闭启动自动建索引；OpenViking 地址/凭证走 `OPENVIKING_*` 环境变量 → **AI 设置页「OpenViking 记忆库」卡里填的值** → `~/.openviking/ovcli.conf` → `~/.openviking/ov.conf` → 默认 `http://127.0.0.1:1933`
- **在界面里配置（v0.9.4）**：`✨ AI 创作 → ⚙️ AI 设置 → 🧠 OpenViking 记忆库` 可直接填地址/访问令牌并「测试连接」，「保存并生效」当场重建客户端、无需重启；卡上标出**这份凭证当前来自哪一层**。「写入全局配置」会把生效的 `url` + `api_key` 写进 `~/.openviking/ovcli.conf`（**先自动备份、只改这两个字段、其它字段原样保留**；原文件不是合法 JSON 时直接拒绝写入），这样 GUI 会话与写作任务读到的就是同一份凭证——否则容易出现「工坊连上了、AI 写作却召回不到」的错觉。
- **降级**：OpenViking 服务器不可用时语义召回静默跳过，写作与装配完全不受影响。
- **模型从哪来（不必联网）**：公开端口用的本地 embedding 模型 `bge-small-zh-v1.5-f16` 已经随源码带了一份
  （`vendor/models/`，47.9 MB，SHA256 可校验），把 OpenViking 的 `ov.conf` 里 `embedding.dense.model_path`
  指过来即可 —— 服务端就不会再去 HuggingFace 下载。完整下载地址、配置字段说明、验证清单与常见问题见
  **[docs/openviking-embedding-setup.md](docs/openviking-embedding-setup.md)**；
  核对或补齐那一份用 `node scripts/fetch-embedding-model.mjs --verify-only`（去掉 `--verify-only` 即补齐）。

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

`ai/context/`：`assemble`（唯一上下文装配器，P2 起）、`renderSection`（单层渲染）。
`ai/policy.mjs`：模型档位与思考强度（P4 起为唯一来源）。

`openviking-sync.js`：`syncWorkFull`（记忆库全量同步）、`getSemanticRecall`（语义召回）、`getLibraryRecall`（共享资料召回，独立 find / 预算 / 微缓存）、`semanticSearchMerge`（检索合并）。

`harness.js`：harness 任务（会话级，含成功/失败/超时/取消四种结局）。

---

## 🧪 测试与验证

```bash
# 离线清单（50 条：不需要实例、不碰你的数据、零计费）——CI 跑的就是这一条
node scripts/ci-offline-checks.mjs

# 活实例回归：起一个隔离实例（临时数据目录 + 停用 OpenViking）再跑，跑完自动关掉
node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs
node scripts/ci-isolated-run.mjs --port 3738 -- node harness-plugins/novel-writing/test/smoke.mjs

# 前端执行验证（最小 DOM 桩里真跑 public/app.js：渲染、开关、节点上报、形状摘要）
node frontend-test.mjs
```

> 这三条都有 CI 兜底（`.github/workflows/ci.yml`：Windows + Linux、Node 24，另有一格
> Node 22.15 验证依赖下限）。CI **绝不调用真实模型**——离线项只读文件，活实例项用本机
> 假端点/死端口。要跑齐**全部**验收（含需要你自己数据的那些）用
> `node .p1-baseline/verify-all.mjs`，缺前置的项会被标成「跳过」而**不是**通过。
