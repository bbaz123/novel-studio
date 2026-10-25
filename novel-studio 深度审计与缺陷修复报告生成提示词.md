# novel-studio 深度审计与缺陷修复报告生成提示词

> 适用对象：Claude Code、Codex、Cursor Agent、GitHub Copilot Coding Agent、OpenHands、具备终端与代码执行能力的其他 Coding Agent。  
> 审计对象：<https://github.com/bbaz123/novel-studio>  
> 最终交付物：项目根目录下的 `缺点及修复报告.md`

---

# 任务总述

你是一名同时具备以下能力的高级审计与设计专家：

- AI 写作产品负责人
- 小说创作工作流专家
- AI Agent / LLM 应用架构师
- Context Engineering 与 Prompt Engineering 专家
- 全栈软件架构师
- 数据模型与数据库设计专家
- 编辑器与知识管理产品专家
- 软件测试、性能、安全与可靠性审计专家
- 开源项目代码审查与渐进式重构专家

现在需要你对开源项目 `novel-studio` 进行一次**基于真实仓库、实际运行、完整调用链和用户场景的深度联合审计**。

项目地址：

```text
https://github.com/bbaz123/novel-studio
```

最终必须在项目根目录生成：

```text
缺点及修复报告.md
```

这不是一次 README 摘要，也不是一篇泛泛的产品评论。你的工作目标是：

```text
完整扫描仓库
→ 锁定被审计版本
→ 理解技术架构
→ 安装并运行
→ 验证关键流程
→ 追踪 AI 调用链
→ 模拟长篇小说创作
→ 识别真实缺陷
→ 提供源码证据
→ 设计修复架构
→ 给出迁移路径
→ 制定验收标准
→ 输出正式审计报告
```

最终报告必须足以回答：

1. novel-studio 作为 AI 小说写作工具，真正做得好的地方是什么？
2. 它相较于直接使用 ChatGPT、Claude 或普通 AI 编辑器，真正多提供了什么？
3. 它目前最核心的产品特色和差异化是什么？
4. 哪些特色已经深入到数据模型和 AI 调用链，哪些只是 UI 层包装？
5. 它目前有哪些产品、AI、数据、架构、交互、性能、安全和工程缺陷？
6. 它能否稳定支持 100 章、300 章、500 章以及 50 万～200 万字的小说？
7. 如果要把它升级为专业 AI Novel IDE 或 Novel Writing Agent，应该如何修改？
8. 哪些问题最值得优先修复，具体应修改哪些文件、增加哪些模块、如何验收？

---

# 一、最高优先级执行原则

## 1. 先调查，再判断

禁止在未完成仓库扫描和核心调用链阅读前下结论。

所有重大判断必须尽可能来自以下至少一种证据：

- 实际运行结果
- 构建、测试、Lint、TypeScript 检查结果
- 真实源码调用链
- 数据库 Schema 或持久化实现
- Prompt / Context 构建代码
- UI 实际交互行为
- 可复现的错误日志
- 性能或规模测试
- 明确标注的高可信静态推断

## 2. 锁定审计版本

在报告开头记录：

```text
Repository
Default branch
Checked-out branch
Commit hash
Commit date
Audit date
Runtime environment
Node / npm / pnpm / yarn version
Operating system
```

示例命令：

```bash
git remote -v
git branch --show-current
git rev-parse HEAD
git log -1 --format='%H%n%ad%n%s' --date=iso
node -v
npm -v
pnpm -v
yarn -v
```

禁止只写“审计了最新版本”，必须写出具体 Commit。

## 3. 区分结论可信度

所有重要结论都必须标注为以下之一：

### 已确认

通过运行、测试、界面行为、日志或源码直接确认。

### 高可信推断

未能完成端到端运行，但根据完整调用链、数据流或静态代码可以合理判断。

### 尚未验证

受 API Key、网络、操作系统、桌面环境、外部服务或缺失依赖限制，无法完成验证。

不得把推断写成实际测试结果。

## 4. 证据必须可追溯

每个主要优点和缺陷尽量提供：

```text
文件路径
类 / 函数 / Hook / Component / API 名称
关键逻辑说明
行号或代码片段
调用方向
运行或复现步骤
```

如果行号会因改动不稳定，可同时记录符号名。

禁止使用：

> 项目似乎没有长期记忆。

应该写成：

> 已确认：章节生成入口 `xxx` 调用 `xxx` 构建上下文；该函数仅加入当前章节、最近两章和静态人物简介，未读取时间线、人物动态状态或未完成伏笔。全文搜索 `embedding`、`timeline`、`plot thread`、`story state` 后未发现对应实现。因此当前系统没有可支撑长篇一致性的动态 Story Memory。

## 5. 不得为了“报告好看”虚构问题

如果某项能力已经实现，必须客观说明其实现质量，不得强行写成缺失。

如果某个问题只是潜在风险，应明确标为“风险”或“高可信推断”，不能写成已发生 Bug。

## 6. 尽量不污染仓库

除最终报告外，不要无必要修改项目源码。

如安装、构建或运行导致以下文件变化：

- lockfile
- generated files
- cache
- local database
- `.env`
- build output

需要在报告中说明，必要时恢复无关修改。

可使用：

```bash
git status --short
git diff --stat
```

最终应确认：

```text
除缺点及修复报告.md及明确说明的审计辅助文件外，不应留下无关代码改动。
```

---

# 二、第一阶段：克隆、扫描与仓库画像

执行：

```bash
git clone https://github.com/bbaz123/novel-studio.git
cd novel-studio
```

如仓库已经存在，先检查：

```bash
git status
git remote -v
git fetch --all --tags
```

然后建立完整仓库画像。

至少检查：

- `README*`
- `LICENSE`
- `CONTRIBUTING*`
- `package.json`
- `pnpm-lock.yaml`
- `package-lock.json`
- `yarn.lock`
- `tsconfig*`
- `vite.config*`
- `next.config*`
- `electron*`
- `tauri*`
- `src`
- `app`
- `pages`
- `components`
- `features`
- `hooks`
- `stores`
- `state`
- `services`
- `api`
- `server`
- `backend`
- `database`
- `schema`
- `migrations`
- `models`
- `repositories`
- `prompts`
- `agents`
- `ai`
- `llm`
- `providers`
- `utils`
- `config`
- `docs`
- `scripts`
- `tests`
- `e2e`
- `fixtures`
- `public`
- `desktop`
- 本地存储、导入导出与备份代码
- 编辑器实现
- 小说项目数据模型
- 人物、地点、世界观、大纲、分卷、章节、场景、伏笔、时间线相关结构

如果目录名称不同，自行识别实际对应模块。

可以使用：

```bash
find . -maxdepth 3 -type f | sort
git ls-files
rg -n "OpenAI|Anthropic|Gemini|DeepSeek|OpenRouter|Ollama|LLM|prompt|context|stream"
rg -n "chapter|character|world|outline|timeline|memory|summary|embedding"
rg -n "localStorage|IndexedDB|SQLite|Dexie|Prisma|Drizzle|supabase|database"
rg -n "JSON\.parse|zod|schema|structured output|tool calling"
```

不要机械逐文件复述。

必须在脑中建立以下四套模型：

1. 技术架构模型
2. 产品功能模型
3. 小说数据模型
4. AI 生成与记忆模型

---

# 三、第二阶段：运行、构建与基础验证

根据项目实际技术栈选择正确命令。

示例：

```bash
npm install
npm run dev
npm run build
npm run lint
npm test
npx tsc --noEmit
```

或：

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm exec tsc --noEmit
```

同时检查 `package.json` 中所有可用脚本，不要只运行常见命令。

## 必须记录

- 安装是否成功
- 启动是否成功
- 开发模式是否成功
- Production Build 是否成功
- Lint 是否成功
- TypeScript 检查是否成功
- Unit Test 是否成功
- Integration Test 是否成功
- E2E 是否存在、是否成功
- 首屏是否可用
- Console 是否报错
- Network 请求是否报错
- 是否存在缺失环境变量
- 是否必须配置模型 API Key
- 首次启动是否有配置向导
- 是否有演示数据
- 是否存在崩溃、白屏或不可恢复错误
- 是否有错误边界和用户可理解的错误提示

## 如果运行受阻

不得停止分析。

必须按以下格式记录：

```text
阻塞步骤
执行命令
错误输出
初步原因
对应源码
受影响功能
可继续完成的静态分析
尚未验证的内容
```

然后沿调用链继续分析。

禁止写：

> 项目无法运行，所以无法评价。

## 运行证据

报告中应至少包含一张运行结果表：

| 检查项 | 命令 | 结果 | 关键输出 | 结论可信度 |
|---|---|---|---|---|
| Install | `...` | 成功/失败 | `...` | 已确认 |
| Build | `...` | 成功/失败 | `...` | 已确认 |
| Lint | `...` | 成功/失败 | `...` | 已确认 |
| Test | `...` | 成功/失败 | `...` | 已确认 |
| TSC | `...` | 成功/失败 | `...` | 已确认 |

---

# 四、第三阶段：建立当前架构与数据流

报告中必须画出项目真实架构，而不是套用通用模板。

至少说明以下链路是否真实存在：

```text
用户
 ↓
小说项目
 ↓
世界观 / 人物 / 地点 / 势力 / 大纲 / 分卷 / 章节
 ↓
编辑器
 ↓
AI 操作
 ↓
任务解析
 ↓
Context 构建
 ↓
Prompt 构建
 ↓
LLM Provider
 ↓
流式生成
 ↓
结果预览 / Diff
 ↓
写入章节
 ↓
摘要 / 状态提取
 ↓
项目持久化
```

必须找到并说明：

- 应用入口
- 路由与主要页面
- 编辑器入口
- AI 请求入口
- AI 功能触发入口
- Prompt Template
- System Prompt
- Context Builder
- LLM Provider abstraction
- Streaming 实现
- Abort / Cancel
- Timeout
- Retry
- Rate Limit
- Token 统计
- 模型配置
- 结构化输出解析
- 数据落盘
- 自动保存
- 导入导出
- 数据迁移
- 小说项目创建
- 章节创建与排序
- 人物、世界观、大纲的存储
- 章节生成后的状态更新

报告必须明确回答：

> 这个软件到底通过什么数据、什么代码路径和什么 Prompt，让 AI 理解一部小说？

如果答案是“AI 实际只接收到静态简介和部分正文”，必须明确指出，不得因为 UI 中有“人物”“世界观”页面就认定 AI 真正使用了这些数据。

---

# 五、第四阶段：建立功能—数据—AI 映射矩阵

对每类小说资产建立矩阵：

| 资产类型 | 是否可创建 | 是否结构化存储 | 是否可编辑 | 是否进入 AI Context | 是否动态更新 | 是否可检索 | 是否有一致性检查 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 小说基本信息 |  |  |  |  |  |  |  |
| 世界观 |  |  |  |  |  |  |  |
| 人物 |  |  |  |  |  |  |  |
| 人物关系 |  |  |  |  |  |  |  |
| 地点 |  |  |  |  |  |  |  |
| 势力 |  |  |  |  |  |  |  |
| 能力体系 |  |  |  |  |  |  |  |
| 大纲 |  |  |  |  |  |  |  |
| 分卷 |  |  |  |  |  |  |  |
| 章节计划 |  |  |  |  |  |  |  |
| 场景 |  |  |  |  |  |  |  |
| 时间线 |  |  |  |  |  |  |  |
| 伏笔 |  |  |  |  |  |  |  |
| 剧情线 |  |  |  |  |  |  |  |
| 人物动态状态 |  |  |  |  |  |  |  |
| 章节摘要 |  |  |  |  |  |  |  |

这个矩阵用于识别：

- 只存在于 UI 的能力
- 只存储但未进入 AI 的能力
- 进入 AI 但没有更新机制的能力
- 真正形成闭环的能力

---

# 六、第五阶段：模拟真实小说创作

不要只检查“页面能否打开”。

请模拟一部完整小说，至少包含：

- 小说标题
- 类型与受众
- 故事简介
- 核心冲突
- 世界观
- 时间与地理
- 力量体系
- 主角
- 2～3 个配角
- 反派
- 人物关系
- 主线剧情
- 至少 2 条支线
- 分卷规划
- 章节规划
- 伏笔与回收点

建议设计一部 100 章以上的虚构小说，并分析系统扩展至：

```text
100 章
300 章
500 章
500,000 字
1,000,000 字
2,000,000 字
```

时的行为。

## 场景 A：创建小说

观察：

- 新建流程是否清晰
- 必填项是否合理
- 项目结构是否可理解
- 是否支持模板
- 是否提供 AI 辅助
- AI 辅助结果是否可编辑
- 首次使用成本如何

## 场景 B：创建人物

测试与分析：

- 静态人物简介
- 外貌
- 性格
- 目标
- 动机
- 恐惧
- 秘密
- 人物弧
- 关系
- 当前状态
- 知识边界
- 物品
- 能力
- 伤病
- 生死状态

重点判断：

> AI 后续写作是否真的能稳定使用这些信息，还是仅在创建时生成一段简介？

## 场景 C：世界观

判断世界观是否只是长文本框，还是结构化管理：

- 地点
- 国家
- 势力
- 历史
- 宗教
- 规则
- 能力体系
- 社会制度
- 物品
- 组织
- 地图或空间关系
- 世界变化

## 场景 D：剧情规划

分析以下层级是否清晰：

```text
全书主题
→ 全书大纲
→ 主线 / 支线
→ 分卷
→ 章节
→ 场景
→ 节拍
```

检查：

- 是否支持拖拽排序
- 是否有父子关系
- 是否有依赖关系
- 是否能从大纲生成章节计划
- 是否能从章节计划生成场景
- 修改上层大纲后下层是否会失效或提醒

## 场景 E：AI 写第 1 章

记录模型真实接收到的 Context：

- 当前写作任务
- 小说简介
- 世界观
- 人物
- 大纲
- 分卷计划
- 章节计划
- 风格要求
- 目标字数
- 禁止事项

检查生成结果如何写回。

## 场景 F：AI 写第 50 章

判断它是否知道：

- 近期发生的事件
- 人物当前所在地点
- 人物关系变化
- 已经掌握的秘密
- 已经失去的物品
- 已经获得的能力
- 尚未回收的伏笔
- 当前时间
- 战力变化

## 场景 G：AI 写第 300 章

重点判断系统是否仍能维持：

- 人物一致性
- 时间线一致性
- 地理一致性
- 能力体系一致性
- 信息揭示顺序
- 人物知识边界
- 剧情线连续性
- 伏笔回收状态
- 风格稳定性

## 场景 H：修改旧章节

假设第 15 章原本角色 A 死亡，后来改为角色 A 受伤存活。

检查系统是否具备：

- 下游依赖检测
- Timeline invalidation
- Chapter summary 重建
- Embedding 更新
- Character state 回滚与重算
- Plot thread 更新
- 后续章节冲突提醒
- 局部重建而非全量重建

如果不存在，这是长篇创作的重要架构缺陷。

## 场景 I：AI 改写正文

检查：

- 是否直接覆盖原文
- 是否生成 Proposal
- 是否有 Diff
- 是否可逐段接受
- 是否可拒绝
- 是否支持 Undo
- 是否有版本快照
- 操作失败时是否可恢复

---

# 七、第六阶段：AI Writing Architecture 深度审计

这是整份报告的核心。

必须找到所有与以下内容相关的代码：

- System Prompt
- Prompt Template
- User Prompt
- Context Builder
- AI Command
- Agent
- Tool Calling
- Summary
- Memory
- Retrieval
- Embedding
- Structured Output
- Streaming
- Retry
- Model Router
- Cost / Token 统计

对每个 AI 功能建立调用链：

```text
UI 操作
→ Event Handler
→ Store / Hook / Service
→ Context Builder
→ Prompt Builder
→ Provider
→ Stream Parser
→ Result Handler
→ Persistence
```

建议至少覆盖：

- 续写
- 扩写
- 缩写
- 润色
- 改写
- 章节生成
- 大纲生成
- 人物生成
- 世界观生成
- Brainstorm
- 对话优化
- 场景描写
- 一致性检查

如果多个按钮各自独立拼 Prompt，必须指出：

- Prompt 重复
- Context 规则不一致
- Token 策略不一致
- 错误处理不一致
- 后续扩展困难
- 难以统一做记忆和安全控制

---

# 八、Prompt Engineering 审计

判断 Prompt 是否包含：

- 清晰角色定义
- 当前写作任务
- 小说背景
- 当前章节目标
- 场景信息
- 人物状态
- 人物知识边界
- 世界规则
- 剧情约束
- 风格约束
- 视角
- 时态
- 目标长度
- 输出格式
- 禁止事项
- 冲突解决规则
- 上下文优先级
- 对未知信息的处理
- 不得擅自改变设定的规则
- 不得重复已揭露信息的规则
- 不得提前回收伏笔的规则

特别检查是否只是：

```text
这是小说背景……
这是人物……
这是前文……
请继续写……
```

如果是，需要解释为什么这种 Prompt：

- 对短篇可能可用
- 对长篇不稳定
- 无法表达信息优先级
- 无法区分静态设定和动态状态
- 无法处理设定冲突
- 容易让模型混淆“作者计划”和“故事已发生事实”
- 容易产生提前剧透、人物越权和时间线错误

检查 Prompt 是否将以下不同语义混在一起：

```text
Canon Facts
Author Intent
Current State
Recent Events
Retrieved Memories
Style Guide
Current Task
Output Contract
```

如混在一个长字符串中，提出分层设计。

---

# 九、Context Engineering 审计

重点回答：

> 系统每次到底向模型发送了什么？

查清以下内容是否进入 Context：

- 当前用户指令
- 当前选中文本
- 当前章节正文
- 当前章节计划
- 上一章节
- 最近 N 章
- 分卷大纲
- 全书大纲
- 人物静态资料
- 人物动态状态
- 世界观
- 地点
- 势力
- 时间线
- 剧情线
- 伏笔
- 章节摘要
- 写作风格
- 作者约束
- 检索结果

## 必须分析的问题

### 1. Context 是否无限增长

小说越来越长时，Context 如何控制？

### 2. 是否按 Token 而不是字符截断

检查：

- 字符数
- 单词数
- Token 估算
- 模型实际 Context Window
- Output Reserve

### 3. 截断策略是否合理

按什么顺序删除：

- 最旧章节
- 静态设定
- 大纲
- 人物
- 最近剧情
- 当前章节

### 4. 是否有 Context Priority

合理优先级可参考：

```text
P0 当前用户指令
P1 当前章节 / 场景计划
P2 当前 Story State
P3 当前人物状态与知识边界
P4 当前地点与相关世界规则
P5 最近剧情
P6 强相关历史事件
P7 未完成剧情线与伏笔
P8 分卷摘要
P9 全书背景
```

### 5. 是否有去重

检查重复加入：

- 小说简介
- 大纲
- 人物简介
- 章节摘要
- 最近章节正文

### 6. 是否有冲突检测

当人物卡、大纲、章节正文和摘要相互冲突时，系统听谁的？

### 7. 是否有 Context 可观测性

用户或开发者能否看到：

- 本次选了哪些上下文
- 每部分占多少 Token
- 为什么选中
- 为什么被丢弃
- 最终 Prompt 大小
- 模型输出 Token
- 成本

如果没有，建议设计 Context Inspector。

---

# 十、长期记忆系统审计

小说写作不能只依赖聊天上下文。

检查项目是否存在真正的 Novel Memory。

## 1. Story Bible

至少应覆盖：

- 世界规则
- 地理
- 国家
- 势力
- 历史
- 宗教
- 能力体系
- 物品
- 组织
- 文化
- 禁忌

## 2. Character Memory

至少应区分：

```text
Character
├── Static Profile
├── Personality
├── Goals
├── Fears
├── Secrets
├── Relationships
├── Knowledge
├── Inventory
├── Abilities
├── Current State
├── Location
├── Health
├── Alive / Dead
└── Arc Progress
```

## 3. Plot Memory

至少应包括：

```text
Plot
├── Main Plot
├── Subplots
├── Open Threads
├── Resolved Threads
├── Foreshadowing
├── Payoffs
├── Mysteries
└── Dependencies
```

## 4. Timeline

至少应包括：

```text
Event
├── storyTime
├── chapterId
├── location
├── participants
├── cause
├── event
├── consequence
├── source
└── confidence
```

## 5. Canon 与计划分离

检查系统是否区分：

- 已经在正文发生的事实
- 作者规划但尚未发生的内容
- AI 的建议
- 被废弃的旧设定
- 不确定推断

如果不区分，模型容易把未来计划当成已发生事实。

## 6. 记忆更新闭环

检查是否存在：

```text
章节生成 / 修改
→ 内容分析
→ 事件抽取
→ 人物状态变更
→ 时间线更新
→ 剧情线更新
→ 伏笔更新
→ 摘要更新
→ 索引更新
```

如果只有静态人物简介和世界观文本，必须明确说明其局限。

---

# 十一、RAG / Retrieval 审计

检查是否存在：

- Embedding
- Vector Database
- Semantic Search
- BM25
- Full-text Search
- Hybrid Search
- Reranking
- Metadata Filter

如果有，评估：

- 索引对象是什么
- 切块策略是什么
- 是否按章节、场景、事件切块
- 是否保留人物、地点、时间等 Metadata
- 更新旧章节后是否重建索引
- 删除内容后是否移除旧向量
- 是否有 Top-K
- 是否有相似度阈值
- 是否有重排
- 是否有 Token Budget
- 检索内容是否去重
- 是否会检索到未来章节
- 是否区分 Canon 与草稿

如果没有，不要机械写“必须增加向量数据库”。

先判断：

- 项目当前规模是否需要 RAG
- 哪些信息更适合结构化查询
- 哪些信息更适合语义检索
- 哪些信息必须按时间、人物或剧情过滤

适合小说写作的 Retrieval Score 可参考：

```text
score =
0.30 × semantic_similarity
+ 0.20 × recency
+ 0.20 × character_overlap
+ 0.15 × plot_relevance
+ 0.10 × location_relevance
+ 0.05 × manual_priority
```

可根据项目实际情况调整。

必须说明：

> RAG 不能替代 Story State。语义相似只能帮助找相关旧内容，不能可靠维护人物生死、物品归属、关系变化和时间线等结构化事实。

---

# 十二、Story State 系统审计

判断项目是否存在明确的动态故事状态。

参考：

```ts
interface StoryState {
  currentChapterId: string;
  currentStoryTime?: string;
  currentLocations: Record<string, string>;

  characters: Record<string, CharacterState>;
  relationships: RelationshipState[];

  inventories: Record<string, InventoryItem[]>;
  abilities: Record<string, AbilityState[]>;

  openPlotThreads: PlotThread[];
  resolvedPlotThreads: PlotThread[];

  foreshadowing: ForeshadowingState[];
  timeline: TimelineEvent[];

  worldChanges: WorldStateChange[];
}
```

如果项目只保存：

- 章节
- 人物简介
- 世界观简介
- 大纲

但没有动态 Story State，必须解释为什么随着小说增长容易出现：

- 人物“复活”
- 人设漂移
- 人物知道自己不该知道的信息
- 道具凭空出现
- 道具归属错误
- 战力失控
- 地点瞬移
- 时间线错误
- 秘密重复揭露
- 伏笔遗忘
- 已完成剧情线再次出现

---

# 十三、章节生成 Pipeline 审计

分析当前章节生成是否只是：

```text
Prompt
→ LLM
→ Chapter
```

如果是，评估问题。

设计推荐 Pipeline：

```text
用户提出写作任务
 ↓
Task Parser
 ↓
Context Planner
 ↓
Memory Retrieval
 ↓
Scene Planner
 ↓
Continuity Pre-check
 ↓
Draft Writer
 ↓
Character Consistency Checker
 ↓
World Rule Checker
 ↓
Plot Consistency Checker
 ↓
Style Editor
 ↓
Final Proposal
 ↓
User Accept / Reject
 ↓
State Extractor
 ↓
Memory / Index Update
```

对每一步说明：

- 输入
- 输出
- 是否必须调用 LLM
- 可否程序化
- 使用大模型还是小模型
- 是否同步
- 是否异步
- 是否可跳过
- 失败时如何降级
- 成本与延迟

---

# 十四、AI Agent 化程度评估

将项目归类为：

### Level 1：AI 文本补全工具

### Level 2：AI Chat + 编辑器

### Level 3：Context-aware Writing Assistant

### Level 4：Novel Writing Agent

### Level 5：Autonomous Story Engine

不能只给等级。

必须说明：

- 当前已经具备哪些能力
- 哪些能力只是表面存在
- 缺少哪些关键闭环
- 升到下一级需要哪些架构改造

---

# 十五、模型 Provider 设计审计

检查是否支持：

- OpenAI
- Anthropic
- Gemini
- DeepSeek
- OpenRouter
- Ollama
- 自定义 OpenAI-compatible API

如支持多个 Provider，评估抽象是否合理。

参考接口：

```ts
interface LLMProvider {
  listModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
  countTokens?(request: ChatRequest): Promise<number>;
  abort?(requestId: string): void;
}
```

建议模型能力结构：

```ts
interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  streaming: boolean;
  structuredOutput: boolean;
  toolCalling: boolean;
  reasoning: boolean;
  vision: boolean;
}
```

重点检查：

- Provider 与业务逻辑是否耦合
- Prompt 是否针对某个 Provider 硬编码
- Streaming 事件格式是否统一
- Abort 是否真正中止请求
- Timeout
- Retry
- Backoff
- Rate Limit
- Model Capability
- 上下文窗口识别
- 最大输出限制
- 错误标准化
- 网络异常恢复
- API Key 存储
- 自定义 Base URL 校验

---

# 十六、Structured Output 审计

检查是否大量依赖：

```text
让模型输出 JSON
→ 截取字符串
→ JSON.parse
```

如是，检查：

- Markdown code fence
- 多余自然语言
- 缺少字段
- 字段类型错误
- 枚举错误
- 部分 JSON
- 流式 JSON
- Unicode / 转义问题
- Schema 版本升级
- 失败重试
- 自动修复
- 用户取消
- Provider 不支持结构化输出时的降级

建议：

- JSON Schema
- Zod
- Provider Structured Output
- Schema Validation
- Repair
- Bounded Retry
- Error Telemetry
- 原始输出留档

---

# 十七、编辑器与专业写作体验

参考 Scrivener、Novelcrafter、Sudowrite、NovelAI、Obsidian、VS Code、Notion 等产品的工作流，但不要堆竞品功能清单。

重点检查：

- 项目树
- 分卷与章节树
- 拖拽排序
- 多文档标签
- 快捷键
- 自动保存
- 保存状态提示
- Undo / Redo
- 全文搜索
- 替换
- 专注模式
- Markdown / Rich Text
- 字数统计
- 目标字数
- 版本历史
- 快照
- Diff
- AI 修改预览
- Accept / Reject
- 选中文本 AI 操作
- 大纲与正文联动
- 章节之间快速跳转
- 大型项目加载性能

判断是否适合作者每天连续使用 2～6 小时。

---

# 十八、AI UX 审计

检查是否提供：

- 续写
- 扩写
- 缩写
- 润色
- 改写
- 描写增强
- 对白优化
- 节奏调整
- 视角调整
- 文风调整
- 情绪增强
- 冲突增强
- 场景生成
- Brainstorm
- 章节规划
- 人物生成
- 世界观生成
- 一致性检查

重点不是数量，而是：

1. 是否共享统一 Context Engine
2. 是否共享统一 Prompt 层
3. 是否共享统一 Provider 层
4. 是否共享统一错误处理
5. 是否可预览和撤销
6. 是否尊重作者选区和光标位置
7. 是否明确显示 AI 正在做什么
8. 是否支持停止生成
9. 是否会覆盖用户未保存内容
10. 是否有成本和模型透明度

---

# 十九、AI 修改安全机制

AI 修改正文时必须重点检查：

- 是否直接覆盖正文
- 是否保留原文
- 是否可 Undo
- 是否有 Diff
- 是否有 Preview
- 是否可逐段接受
- 是否可全部接受
- 是否可拒绝
- 是否有版本快照
- 页面刷新后 Proposal 是否还在
- 生成失败是否破坏原文

推荐：

```text
Original
 ↓
AI Proposal
 ↓
Diff View
 ↓
Accept / Reject
 ↓
Commit
```

如果 AI 可直接覆盖作者正文且没有可靠恢复机制，列为高优先级问题。

---

# 二十、数据安全与可靠性

小说内容属于作者的重要知识产权。

检查数据存储：

- localStorage
- IndexedDB
- SQLite
- 文件系统
- 服务端数据库
- 云端同步
- 第三方服务

分析：

- 数据丢失风险
- 自动保存
- 保存原子性
- 崩溃恢复
- 版本历史
- 快照
- 备份
- 导出
- 导入
- 数据迁移
- Schema 版本
- 损坏检测
- 多窗口并发写入
- 跨设备同步冲突
- 用户删除项目
- 回收站
- 大文件导入
- 导出格式可持续性

至少回答：

> 用户写了 50 万字后，应用升级、浏览器清理、数据库迁移失败、设备损坏或程序崩溃时，能否可靠恢复？

---

# 二十一、性能与规模

模拟或静态分析以下规模：

```text
500 chapters
1,500,000 words
100 characters
200 world entries
500 timeline events
1,000 plot / memory records
```

判断：

- UI 是否一次性渲染全部章节
- 是否一次性加载全部正文
- 是否有虚拟列表
- 是否有分页或懒加载
- 搜索是否全量线性扫描
- 自动保存是否频繁写入全部项目
- 每次编辑是否序列化全部数据
- Context 是否随项目规模线性增长
- Embedding 是否全量重建
- React / Vue / Svelte render 是否过多
- Store 更新是否引发全局刷新
- DB 查询是否有索引
- 是否存在 O(n²) 路径
- 大纲树递归是否稳定
- 导出大项目是否占用过多内存

如无法实际压测，应明确标注为高可信静态推断，并说明推断依据。

---

# 二十二、工程质量

检查：

- TypeScript 严格度
- `any`
- `unknown`
- 类型断言
- 大型组件
- God Component
- 重复代码
- Hook 设计
- Store 设计
- Service Layer
- Repository Layer
- API Layer
- Domain Model
- Error Boundary
- Logging
- Telemetry
- Testability
- Unit Test
- Integration Test
- E2E
- Fixtures
- Mock Provider
- Dependency Injection
- 配置管理
- 环境变量校验
- Circular Dependency
- Dead Code
- 未使用依赖
- Bundle Size
- 可访问性
- 国际化

特别关注：

> 业务逻辑是否大量写在 UI Component 中，导致 Prompt、数据操作、请求和界面状态紧密耦合？

---

# 二十三、安全审计

检查：

- API Key 存储
- API Key 是否进入日志
- API Key 是否进入前端 Bundle
- XSS
- `dangerouslySetInnerHTML`
- Markdown Renderer
- HTML 导入
- 文件导入
- 路径穿越
- Electron / Tauri 权限
- 任意文件访问
- 自定义 Base URL
- SSRF 风险
- Prompt Injection
- 恶意小说文本影响系统指令
- 第三方模型请求中的隐私暴露
- 日志中的小说正文
- 导出文件中的敏感配置

发现真实安全问题时，按以下格式说明：

```text
文件
符号 / 行号
风险等级
触发条件
影响
是否已验证
修复方案
验收方法
```

不要夸大风险。

---

# 二十四、产品优势分析

报告不能只批评。

必须专门分析 novel-studio 做得好的地方，例如：

- 小说项目化组织
- 写作工作流
- 本地优先
- 模型兼容
- 大纲系统
- 人物管理
- 世界观管理
- 编辑器
- AI 集成
- UI 信息架构
- 数据可移植性
- 开源可扩展性

但所有结论必须来自真实源码或实际体验。

禁止写：

> 界面简洁，功能强大。

应该写成：

> 项目将 `XXX`、`XXX`、`XXX` 组织为 `XXX` 数据结构，并在 `XXX` 中用于章节生成，因此相较于普通聊天窗口，它具备 `XXX` 优势。该结论已通过 `文件/函数/运行路径` 确认。

---

# 二十五、产品特色与差异化

必须回答：

> 如果作者已经有 ChatGPT 或 Claude，为什么还需要 novel-studio？

从以下角度判断：

```text
Project-based Writing
Structured Novel Data
Story Bible
Persistent Context
Writing Workflow
AI Editing
Long-term Story Management
Local-first
Provider Choice
Version Safety
```

然后区分：

- 已真正实现
- 部分实现
- 仅 UI 层存在
- 尚未进入 AI Context
- 具有潜力但未闭环

---

# 二十六、缺陷分级

所有主要问题按照以下标准分级。

## P0

会导致：

- 数据丢失
- 项目无法启动
- 内容严重损坏
- API Key 泄露
- 用户正文不可恢复地被覆盖
- 明确的高危安全问题

## P1

严重影响核心小说创作：

- 长篇一致性
- Story Memory
- Context
- 章节生成质量
- 状态更新
- AI 修改安全
- 大型项目不可用
- 关键 Provider 失效

## P2

明显影响体验或效率：

- UX
- 编辑器工作流
- 性能退化
- 搜索
- 导入导出
- 错误提示
- 配置体验

## P3

优化类问题：

- 代码质量
- 测试覆盖
- UI Polish
- 小型架构债务
- 可维护性改善

不得为了显得严重而把所有问题都列为 P0/P1。

---

# 二十七、每个缺陷统一模板

每个主要缺陷必须使用以下结构：

```markdown
## [P1-01] 缺少真正的长期 Story Memory

### 结论可信度
已确认 / 高可信推断 / 尚未验证

### 当前实现
说明现有实现和真实调用链。

### 证据
- `src/xxx.ts`：`functionName`
- `src/xxx.tsx`：`ComponentName`
- 运行日志或复现步骤

### 问题
解释为什么这是问题。

### 用户影响
说明作者在 100～500 章创作中的实际后果。

### 触发条件 / 复现步骤
1. ...
2. ...
3. ...

### 根因
解释架构根因，而非只复述表面现象。

### 修复方案
给出具体设计。

### 涉及文件
列出建议修改的现有文件。

### 建议新增模块
例如：
- `src/services/storyMemory.ts`
- `src/services/contextEngine.ts`
- `src/services/storyState.ts`

### 数据迁移
说明旧项目如何兼容或升级。

### 实现示例
必要时提供 TypeScript Interface、伪代码或 Schema。

### 测试与验收标准
给出可执行的验收条件。

### 工作量
S / M / L / XL

### 风险与依赖
说明修复前置条件和潜在风险。

### 修复收益
说明实际用户价值和架构杠杆。
```

---

# 二十八、根因分析要求

缺陷不能只停留在功能缺失。

需要区分：

```text
表面现象
→ 直接原因
→ 架构根因
→ 组织 / 演进原因
→ 可行修复点
```

示例：

```text
表面现象：第 100 章忘记人物已经失去某件物品
直接原因：Prompt 没有加入物品状态
架构根因：项目没有 CharacterState 和 StoryState
进一步根因：人物模型只有静态 Profile，章节生成后没有 State Extractor
修复点：新增事件抽取、状态更新、版本化状态和 Context Planner
```

---

# 二十九、设计 Novel Studio 2.0 架构

最终必须给出一套可实施的新版核心架构。

参考：

```text
                         Novel Studio
                              │
                ┌─────────────┴─────────────┐
                │                           │
            Writing UI                 Story Engine
                │                           │
       Editor / Outline / Diff     ┌────────┼────────┐
                                   │        │        │
                              Context   Memory    State
                              Engine    Engine    Engine
                                   │        │        │
                                   └────────┼────────┘
                                            │
                                       AI Gateway
                                            │
                         ┌──────────────────┼──────────────────┐
                         │                  │                  │
                      OpenAI            Anthropic          Others
```

Story Engine 建议包含：

```text
Story Engine
├── Story Bible
├── Character State
├── Relationship Graph
├── Timeline
├── Plot Threads
├── Foreshadowing
├── Locations
├── World Changes
├── Chapter Summaries
└── Canon Registry
```

必须说明：

- 模块职责
- 依赖方向
- 数据流
- 写入流程
- 读取流程
- 缓存
- 失败恢复
- 与现有代码的迁移关系

---

# 三十、Context Engine 设计

设计统一 Context Engine。

参考：

```ts
type ContextItemType =
  | "instruction"
  | "chapter_plan"
  | "scene"
  | "character"
  | "character_state"
  | "world"
  | "location"
  | "chapter"
  | "summary"
  | "timeline"
  | "plot"
  | "foreshadowing"
  | "style";

interface ContextItem {
  id: string;
  type: ContextItemType;
  sourceId: string;
  content: string;

  priority: number;
  relevance: number;
  confidence: number;

  tokenCount: number;
  canonical: boolean;
  storyTime?: string;
  chapterIndex?: number;

  metadata?: Record<string, unknown>;
}
```

参考入口：

```ts
interface BuildContextInput {
  task: WritingTask;
  chapterId: string;
  sceneId?: string;
  selectedText?: string;
  model: ModelCapabilities;
  tokenBudget: number;
}

interface BuildContextResult {
  systemPrompt: string;
  items: ContextItem[];
  droppedItems: ContextItem[];
  inputTokens: number;
  outputReserve: number;
  diagnostics: ContextDiagnostics;
}
```

需要设计：

- 候选收集
- 结构化状态查询
- 语义检索
- Metadata Filter
- 去重
- 冲突检测
- 优先级排序
- Token Budget
- 截断
- Output Reserve
- Context Inspector

模型 128K 的预算示例：

```text
System / Safety                 4K
Task Instruction               4K
Current Chapter Plan           4K
Story State                    8K
Character Memory               8K
World / Location Context       8K
Plot / Timeline Context       12K
Recent Chapters               24K
Retrieved Memory              20K
Current Chapter / Selection   12K
Output Reserve                16K
Other / Buffer                 8K
```

这只是示例，应根据项目实际模型能力优化。

---

# 三十一、Story Memory Engine 设计

建议采用混合记忆：

```text
Structured Memory
+
Chapter Summaries
+
Semantic Retrieval
+
Recent Raw Text
```

说明各自职责：

- Structured Memory：人物状态、关系、物品、能力、剧情线、时间线
- Chapter Summaries：长期剧情压缩
- Semantic Retrieval：找相关旧场景和细节
- Recent Raw Text：保持语言和近因连续性

设计记忆写入流程：

```text
Chapter Commit
 ↓
Event Extractor
 ↓
Entity Resolver
 ↓
State Delta Builder
 ↓
Consistency Validation
 ↓
Memory Commit
 ↓
Summary Update
 ↓
Search Index Update
```

设计版本与来源：

```ts
interface MemoryRecord {
  id: string;
  type: string;
  sourceChapterId: string;
  sourceRange?: { start: number; end: number };
  fact: string;
  canonical: boolean;
  confidence: number;
  validFromChapter: number;
  validToChapter?: number;
  supersedes?: string[];
  createdAt: string;
  updatedAt: string;
}
```

---

# 三十二、Story State Engine 设计

建议 Schema：

```ts
interface StoryState {
  revision: number;
  currentChapter: number;
  currentStoryTime?: string;

  characters: Record<string, CharacterState>;
  relationships: RelationshipState[];

  openPlotThreads: PlotThread[];
  resolvedPlotThreads: PlotThread[];

  foreshadowing: ForeshadowingState[];
  timeline: TimelineEvent[];

  locations: Record<string, LocationState>;
  worldChanges: WorldStateChange[];
}
```

章节完成后：

```text
Chapter
 ↓
State Extractor
 ↓
检测人物、地点、事件、关系、物品、能力、伏笔、剧情
 ↓
生成 State Delta
 ↓
一致性校验
 ↓
用户确认或自动提交
 ↓
更新 Story State
```

必须设计：

- State Delta
- 乐观更新或事务
- 版本号
- 回滚
- 修改旧章节后的重算
- 冲突检测
- 人工修正
- 审计日志

---

# 三十三、旧章节修改与依赖失效设计

这是长篇小说工具的重要能力。

建议设计：

```text
Chapter Edit
 ↓
Detect Semantic Change
 ↓
Compare Old / New Events
 ↓
Invalidate Derived State
 ↓
Find Downstream Dependencies
 ↓
Recompute Affected Summaries / State / Embeddings
 ↓
Produce Continuity Warnings
```

必须说明：

- 如何找受影响章节
- 如何避免全书全量重算
- 如何标记 stale 数据
- 如何重建摘要
- 如何更新向量索引
- 如何回滚 Story State
- 如何提示作者后续冲突

可设计依赖图：

```ts
interface DerivedArtifact {
  id: string;
  type: "summary" | "state" | "embedding" | "timeline" | "plot";
  sourceIds: string[];
  revision: number;
  stale: boolean;
}
```

---

# 三十四、AI Generation Pipeline 设计

建议三种模式。

## Fast Mode

目标：速度优先，1～2 次模型调用。

```text
Context Planner
→ Draft Writer
→ Lightweight State Extraction
```

## Standard Mode

目标：质量、速度、成本平衡，3～4 次调用。

```text
Context Planner
→ Scene Planner
→ Draft Writer
→ Combined Consistency Check + State Extraction
```

## Quality Mode

目标：高质量章节，5～7 次调用。

```text
Task Parser
→ Context Planner
→ Scene Planner
→ Draft Writer
→ Character / World / Plot Checker
→ Style Editor
→ State Extractor
```

对每种模式给出：

- 调用次数
- 使用模型建议
- 延迟
- 成本
- 适用场景
- 可跳过步骤
- 失败降级
- 用户可配置项

用户应可控制：

```text
Speed
Quality
Cost
```

---

# 三十五、AI Gateway 与模型路由设计

建议统一：

```text
Business Feature
→ AI Gateway
→ Provider Adapter
→ Provider API
```

AI Gateway 负责：

- 模型能力检查
- Context Window
- Token Budget
- Retry
- Timeout
- Abort
- Streaming
- Structured Output
- Cost Tracking
- Error Normalization
- Fallback
- Logging Redaction

避免业务层直接依赖某个 Provider SDK。

---

# 三十六、推荐数据模型

报告中给出建议的数据模型关系图或文字模型，至少包含：

```text
NovelProject
├── StoryBibleEntry
├── Character
├── CharacterState
├── Relationship
├── Location
├── Faction
├── Volume
├── Chapter
├── Scene
├── ChapterSummary
├── TimelineEvent
├── PlotThread
├── Foreshadowing
├── MemoryRecord
├── StoryStateRevision
├── AIProposal
└── ProjectSnapshot
```

说明：

- 主键
- 外键
- 版本
- 排序
- 删除策略
- 数据迁移
- Canon 标记
- 来源追踪

---

# 三十七、可观测性设计

建议增加：

- AI Request ID
- Provider / Model
- Prompt Template Version
- Context Item 列表
- Input Tokens
- Output Tokens
- Latency
- Retry Count
- Error Type
- Cost
- User Cancel
- State Extraction Result
- Memory Update Result

注意：

- 不应默认把完整小说正文发送到遥测服务
- 日志应脱敏 API Key
- 用户应可关闭 Telemetry
- 本地调试可保留更详细日志

---

# 三十八、测试策略

修复建议必须配套测试。

至少设计：

## Unit Test

- Context 排序
- Token Budget
- Prompt Template
- State Delta
- Timeline 更新
- Structured Output 解析
- Provider Error Mapping

## Integration Test

- 创建项目
- 创建人物与世界观
- 生成章节
- 接受 AI Proposal
- 状态更新
- 修改旧章节
- 依赖失效与重建
- 导入导出

## E2E Test

- 首次启动
- 配置 Provider
- 创建小说
- 写作
- 自动保存
- 重启恢复
- 导出
- 断网 / API 错误
- 用户取消流式生成

## Long Novel Fixture

创建固定测试数据：

```text
500 chapters
100 characters
200 world entries
500 events
```

用于性能回归。

---

# 三十九、验收标准要求

每个重要修复都必须给出可执行验收标准。

例如：

```text
Given：
角色 A 在第 15 章死亡

When：
生成第 50 章

Then：
Context 中必须包含角色 A 的死亡状态
系统不得让角色 A 以存活状态直接登场
若作者要求复活，系统必须提示与现有 Canon 冲突
```

又如：

```text
Given：
用户将第 15 章从“角色 A 死亡”改为“角色 A 重伤存活”

When：
保存修改

Then：
第 15 章后派生的状态、摘要和索引被标记为 stale
系统列出受影响章节
重建后角色 A 状态更新
旧死亡事实不再进入后续 Context
```

---

# 四十、Roadmap

最终给出分阶段 Roadmap。

## Phase 0：基线与测试

- 锁定行为
- 建立测试
- 加入日志
- 建立长篇 Fixture

## Phase 1：稳定性与数据安全

- 自动保存
- 快照
- 导入导出
- Provider 错误处理
- AI Proposal / Diff
- 数据迁移

## Phase 2：统一 AI Gateway 与 Context Engine

- Provider abstraction
- Token Budget
- Context Priority
- Context Inspector
- Prompt Versioning

## Phase 3：Story Memory 与 Story State

- Character State
- Timeline
- Plot Threads
- Foreshadowing
- State Extractor
- Memory Retrieval

## Phase 4：一致性与旧章节变更传播

- State Delta
- Dependency Graph
- Invalidation
- Rebuild
- Continuity Warning

## Phase 5：高级 Writing Agent

- Scene Planner
- Consistency Checker
- Multi-mode Pipeline
- Model Router
- Cost / Quality Controls

每个 Phase 给出：

- 目标
- 具体模块
- 现有文件
- 新增文件
- 数据迁移
- 复杂度
- 风险
- 前置依赖
- 验收标准
- 用户收益

---

# 四十一、优先级排序方法

最后给出最值得优先修改的 10 个问题。

建议采用：

```text
Priority Score =
User Impact
× Severity
× Architecture Leverage
× Confidence
÷ Development Cost
```

各项可按 1～5 评分。

输出表：

| 排名 | 问题 | 用户收益 | 严重性 | 架构杠杆 | 证据可信度 | 成本 | 综合理由 |
|---:|---|---:|---:|---:|---:|---:|---|

不能只凭主观感觉排序。

---

# 四十二、必须回答的核心结论

报告结尾必须明确回答：

## 1. 当前最有价值的 3～5 个产品优势是什么？

## 2. 相比直接使用 ChatGPT / Claude，它真正多提供了什么？

## 3. 哪些差异化已经进入底层数据与 AI 调用链？

## 4. 哪些功能只是 UI 层存在，没有真正影响 AI？

## 5. 限制它成为专业 AI 小说创作平台的最大技术瓶颈是什么？

## 6. 限制它处理 50 万～200 万字长篇小说的最大架构瓶颈是什么？

## 7. 当前最危险的数据可靠性问题是什么？

## 8. 如果只能修改 3 个系统，优先改哪三个？

优先级依据：

```text
用户收益
× 问题严重性
× 架构杠杆
÷ 开发成本
```

## 9. 它应该继续定位为：

```text
AI Editor
```

还是演进为：

```text
AI Novel IDE
```

或：

```text
Novel Writing Agent
```

必须根据当前代码基础判断。

## 10. 当前项目最合理的下一阶段产品定位是什么？

---

# 四十三、最终报告结构

最终生成：

```text
缺点及修复报告.md
```

必须使用以下结构：

```markdown
# Novel Studio 缺点及修复报告

## 0. 执行摘要

## 1. 审计范围、版本与方法
### 1.1 仓库与 Commit
### 1.2 运行环境
### 1.3 审计方法
### 1.4 结论可信度说明
### 1.5 审计限制

## 2. 项目概览

## 3. 实际运行与测试结果
### 3.1 安装
### 3.2 启动
### 3.3 Build
### 3.4 Lint
### 3.5 TypeScript
### 3.6 Tests
### 3.7 运行阻塞与未验证项

## 4. 当前技术架构

## 5. 当前数据模型

## 6. AI 写作调用链

## 7. 功能—数据—AI 映射矩阵

## 8. 产品优势

## 9. 产品特色与差异化

## 10. 当前 AI 能力等级评估

## 11. Prompt Engineering 分析

## 12. Context Engineering 分析

## 13. 长期记忆能力分析

## 14. Story State / Timeline / Plot 管理分析

## 15. RAG / Retrieval 分析

## 16. Provider 与 Structured Output 分析

## 17. 编辑器与 AI UX 分析

## 18. AI 修改安全机制

## 19. 数据安全与可靠性

## 20. 性能与大型小说可扩展性

## 21. 工程架构与测试问题

## 22. 安全问题

## 23. 主要缺陷总表

| ID | 优先级 | 问题 | 结论可信度 | 用户影响 | 根因 | 修复复杂度 |
|---|---|---|---|---|---|---|

## 24. P0 问题与修复方案

## 25. P1 问题与修复方案

## 26. P2 问题与修复方案

## 27. P3 问题与修复方案

## 28. 推荐 Novel Studio 2.0 架构

## 29. Context Engine 设计

## 30. Story Memory Engine 设计

## 31. Story State Engine 设计

## 32. 旧章节修改与依赖失效机制

## 33. AI Generation Pipeline 设计

## 34. AI Gateway 与模型路由设计

## 35. 推荐数据模型

## 36. 推荐新增模块

## 37. 推荐重构模块

## 38. 数据迁移方案

## 39. 测试与验收方案

## 40. 修复 Roadmap

## 41. 最值得优先修改的 10 个问题

## 42. 核心问题逐项回答

## 43. 最终结论

## 附录 A：关键文件索引

## 附录 B：运行命令与结果

## 附录 C：关键调用链

## 附录 D：未验证项
```

---

# 四十四、报告质量要求

最终报告应达到：

```text
高级架构评审文档
+
正式产品技术审计报告
+
可实施的重构设计
```

不得输出：

- 空泛产品建议
- 通用 AI 建议
- 与源码无关的理论
- 仅凭 README 的推测
- 没有证据的断言
- 为了篇幅重复内容
- 只列功能、不分析调用链
- 只讲架构、不讲用户影响
- 只讲问题、不讲迁移与验收

所有重要判断尽量提供：

```text
具体文件
具体符号
具体数据流
具体运行结果
具体用户场景
具体根因
具体修改方案
具体测试方法
具体验收标准
```

---

# 四十五、禁止事项

禁止：

1. 只看 README。
2. 只看 GitHub 首页。
3. 根据项目宣传语直接评价。
4. 没有运行却声称“实际运行发现”。
5. 找不到功能就立刻认定不存在，必须先全文搜索。
6. 把所有问题都包装成“建议增加 RAG”。
7. 把 Vector Database 当成长期记忆的同义词。
8. 单纯堆砌竞品功能。
9. 只从程序员角度评价，不考虑小说作者工作流。
10. 只从产品角度评价，不分析源码架构。
11. 给出“优化代码”“增强 AI”“提升体验”一类模糊建议。
12. 只列缺陷，不说明证据、根因和验收。
13. 只设计理想架构，不考虑从当前项目迁移。
14. 把 UI 中存在的功能误判为 AI 已真正使用。
15. 把静态人物卡误判为动态 Character Memory。
16. 把最近章节拼接误判为长期记忆。
17. 把语义检索误判为 Story State。
18. 为了凑 P0/P1 而夸大问题。
19. 在报告中暴露真实 API Key、访问令牌或用户正文。
20. 无必要修改项目源码或破坏原仓库状态。

---

# 四十六、推荐执行顺序

严格按以下顺序进行：

## Step 1：锁定版本

记录仓库、分支、Commit、时间、环境。

## Step 2：扫描仓库

建立技术、产品、数据和 AI 心智模型。

## Step 3：运行项目

安装、启动、构建、Lint、TSC、测试。

## Step 4：追踪核心调用链

定位编辑器、AI、Prompt、Context、Provider、持久化。

## Step 5：建立映射矩阵

确认每项小说资产是否进入 AI 和是否动态更新。

## Step 6：模拟长篇写作

覆盖创建、写作、改写、旧章节变更和大规模场景。

## Step 7：分析缺陷

按产品、AI、数据、架构、UX、性能、安全、工程分类。

## Step 8：为每个缺陷补证据

文件、符号、运行日志、复现步骤、可信度。

## Step 9：设计修复架构

Context、Memory、State、Pipeline、Provider、数据迁移。

## Step 10：制定测试与验收

每个高优先级修复必须可验证。

## Step 11：排序 Roadmap

按用户收益、严重性、架构杠杆、成本排序。

## Step 12：生成最终报告

写入项目根目录：

```text
缺点及修复报告.md
```

---

# 四十七、最终完成检查

生成报告前，逐项确认：

- [ ] 已记录具体 Commit hash
- [ ] 已记录运行环境
- [ ] 已执行或尝试 Install
- [ ] 已执行或尝试 Dev
- [ ] 已执行或尝试 Build
- [ ] 已执行或尝试 Lint
- [ ] 已执行或尝试 Test
- [ ] 已执行或尝试 TypeScript 检查
- [ ] 已定位 AI 请求入口
- [ ] 已定位 Prompt 构建
- [ ] 已定位 Context 构建
- [ ] 已定位 Provider
- [ ] 已定位持久化
- [ ] 已建立功能—数据—AI 矩阵
- [ ] 已分析长篇小说场景
- [ ] 已分析旧章节修改
- [ ] 已分析 AI 修改安全
- [ ] 已分析数据丢失风险
- [ ] 已分析性能与规模
- [ ] 已分析安全问题
- [ ] 每个重大问题有源码证据
- [ ] 每个重大问题有用户影响
- [ ] 每个重大问题有根因
- [ ] 每个重大问题有修复方案
- [ ] 每个重大问题有测试与验收
- [ ] 已设计 2.0 架构
- [ ] 已给出 Roadmap
- [ ] 已回答全部核心问题
- [ ] 已区分已确认、高可信推断、尚未验证
- [ ] 未泄露密钥或敏感信息
- [ ] 最终文件名为 `缺点及修复报告.md`

---

# 最终执行指令

现在开始执行审计。

不要先写结论。

先完成仓库扫描、版本锁定、运行验证和关键调用链追踪。

遇到运行阻塞时，记录错误并继续静态分析，不得停止。

所有重要判断必须尽量基于真实源码、运行行为或明确标注的高可信推断。

最终将完整报告直接写入项目根目录：

```text
缺点及修复报告.md
```

除报告本身外，不要用一段几百字的总结替代任务成果。

报告完成后，在终端中确认文件存在，并输出：

```bash
ls -lh 缺点及修复报告.md
```

同时检查：

```bash
git status --short
```

确保没有留下无关修改。
