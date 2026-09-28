# 第三方组件与资产

本文件列出 Novel Studio 仓库内**不由本项目 MIT 许可证覆盖**的第三方组件与资产，各自遵循其上游条款。

---

## 1. 向量模型 `vendor/models/bge-small-zh-v1.5-f16.gguf`

| 项目 | 内容 |
| --- | --- |
| 用途 | OpenViking 共享记忆库的本地向量模型（512 维中文 dense embedding，GGUF 格式，由 llama.cpp 加载） |
| 上游模型 | `BAAI/bge-small-zh-v1.5`（模型卡标注 **MIT**） |
| GGUF 转换件 | [`CompendiumLabs/bge-small-zh-v1.5-gguf`](https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf) |
| 分发方式 | 本仓库**原样随源码分发**（不改动任何字节） |
| 字节数 | 47,886,240 |
| SHA256 | `ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c` |
| 校验命令 | `node scripts/fetch-embedding-model.mjs --verify-only`（离线） |
| 来源与维护说明 | [vendor/README.md](vendor/README.md)；配置方法见 [docs/openviking-embedding-setup.md](docs/openviking-embedding-setup.md) |
| 许可声明口径 | 实际随仓库分发的是 **GGUF 转换文件**；本表同时记录**原模型来源**（`BAAI/bge-small-zh-v1.5`，模型卡 MIT）与 **GGUF 转换来源**（`CompendiumLabs/bge-small-zh-v1.5-gguf`，MIT），再分发时两者都要保留 |

> ⚠️ 上游镜像对该文件返回的 `ETag` 与真实内容 SHA256 **不一致**，校验一律以上表列出的 SHA256 为准
> （该值由"镜像下载件"与"本机缓存件"两份独立算出并等同确认）。

---

## 2. 独立项目（不包含在本仓库内）

以下项目是 Novel Studio 的**可选**协作方，代码不在本仓库内，安装与使用时遵循它们各自的许可证：

| 项目 | 关系 | 许可证 |
| --- | --- | --- |
| **DeepSeek Harness（`dsh`）** | 创作内核宿主：需要 Agent / 工具循环的任务经它执行；轻量直连路径仍由工坊现有 AI Client 执行（路由由现有 AI 策略决定）。本仓库不包含其代码 | MIT；[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，核验 2026-09-27；本机版本 `0.1.7-rc.1`（上游 `master` 当前 `0.1.7-rc.2`，实际以本机安装为准）；第三方依赖见其上游 `THIRD_PARTY_NOTICES.md` |
| **OpenViking** | 语义记忆与检索后端：作品派生资源投影、语义召回与 DSH 会话记忆；不承载正式正文 / 作者长期记忆 / Canon Story State（这些以 Novel Studio 宿主数据为准） | 以本机实际安装版本为准；当前上游主项目 [`volcengine/OpenViking`](https://github.com/volcengine/OpenViking) 为 **AGPL-3.0**（默认分支 `main`，核验 2026-09-27），部分子组件许可证不同 |
| ***SillyTavern*** | 设计上借鉴了它的世界观 / 角色卡 / 作者注组织方式（工坊内「创作上下文」页；本轮来源审计未发现直接引入其源码） | AGPL-3.0（核验 2026-09-27：`SillyTavern/SillyTavern` @ `06bde939fb1e`，默认分支 `release`，`LICENSE`） |

### 2.1 设计 / 方法参考项目（借用思路；本轮来源审计未发现直接引入其源码或大段文本）

以下项目是本轮功能需求与设计的方法来源；工坊内的对应实现均为本项目自行编写。按任务书约定，对 GPL/AGPL 项目不复制其实现或大段文本。关键词全文检索属于**辅助证据**：不能绝对排除"改名 / 去项目名 / 翻译 / 拆分文件"后的复制，如需更强结论需做逐文件来源比对。

| 项目 | 参考方向 | 许可证核验（日期 2026-09-27） |
| --- | --- | --- |
| **SillyTavern** | 角色卡 / 世界书 / 作者注的组织方式 | AGPL-3.0；`SillyTavern/SillyTavern` @ `06bde939fb1e`（默认分支 `release`）；`LICENSE` |
| **Humanizer** | 表达问题识别、保留原意、作者样文、修改后复查 | MIT；`blader/humanizer` @ `9862685f575c`（默认分支 `main`）；`LICENSE` |
| **InkOS** | 语义审稿、三级意图、未来候选、协同提交 | AGPL-3.0-only（仓库 `package` 声明）；`Narcooo/inkos` @ `8fc2ae57080b`（默认分支 `master`）；`LICENSE` |
| **webnovel-writer v8** | 候选/正式内容边界、流程纪律、可恢复投影 | GPL-3.0；`lingfengQAQ/webnovel-writer` **`v8`** @ `b226c87b36743492f1ba2ec38bef66568259a903`（核验分支 `v8`，非默认分支；该库 `master` 为 v6 Claude Code 插件线，`v8` 为基于 DeepSeek Harness 的下一代主线，见其 `v8` README「选择版本」表）；`LICENSE` |
| **Oh Story** | 按时点的知识披露、有限上下文、导入分析、题材方法 | MIT；`zenstory-ai/oh-story-claudecode` @ `4a50d5583590`（默认分支 `main`）；`LICENSE` |

> 核验口径：上表 commit 为核验当日各仓库**参考分支**的最新提交（GitHub API `/repos/{owner}/{repo}/license?ref=` 与 `/branches/`）；其中 `webnovel-writer` 参考的是 **`v8`** 分支（非默认分支）。
> 上表是**来源审计**记录：关键词全文检索与 commit 核验只能证明"按此范围检索未发现直接复制"，不构成"绝对未复制"的证明；后续上游许可证变化不倒推为本轮已使用的版本许可。工坊首页「🙏 借鉴与致谢」展示同一份事实。

---

## 3. 前端运行时依赖

Novel Studio 前端**不使用任何 npm 运行时依赖**（`package.json` 的 `dependencies` 为空），
因此仓库内不包含需要额外声明许可的第三方 JavaScript 库。
