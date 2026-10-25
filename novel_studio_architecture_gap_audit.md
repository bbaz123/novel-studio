# Novel Studio × DeepSeek Harness × OpenViking：架构与差距审计
核查日期：2026-09-26
项目范围：bbaz123/novel-studio，refactor/p0-p6；DSH 与 OpenViking 官方公开资料。

## 证据范围
本轮是公开源码与契约审计，不是对用户本机的运行验收。
读取了工坊当前分支的关键前端、harness 启动器、小说 bundle、安装接线器和 Host Contract，以及 DSH、OV 官方插件文档。
未取得三仓统一锁定的 commit SHA；不同网页抓取结果不能当作同一时刻完整 checkout。
部分宿主文件，尤其 openviking.js、openviking-sync.js 与当前完整 server.js，未能完整获取，因此相关实现细节只按可读契约/文档确认，不能写成全面源码验证。
没有连接用户的 DeepSeek/OV 服务、没有启动用户项目或执行其测试。本文的“已确认”指对应可读代码事实；不等于用户本机已正确安装或实测通过。
实施任务书要求 Codex 在本地重新固定 SHA、检查真实文件并完成运行验证。

## 一、结论
正确方向不是重新搭一个 AI、Skill、记忆或故事状态系统，而是在现有宿主、DSH 小说领域 bundle 和 OV 记忆接入之间补齐真实缺口。
既不能将全部 AI 请求强推 DSH，也不能因为存在直连就把 DSH 当普通可有可无的 HTTP client。
DSH 的 Agent 工具循环与轻任务直连并存，是当前契约的一部分。[S01][S02]

### 组件边界
| 组件 | 已确认的角色 | 不能推出的结论 |
|---|---|---|
| 工坊宿主 | UI、作品数据、唯一上下文装配、确定性状态、审批/事务/恢复 | 不等于还需要一套通用私有插件运行时 |
| novel-writing | 仓内 DSH 标准 bundle，通过 Host HTTP 提供小说工具 | 不直接拥有另一份小说数据库 |
| DSH | Cordis 插件、工具循环和 Agent 生命周期 | 不是所有轻量 AI 请求都必须经过它 |
| OV 宿主适配 | 文档明确有作品资源同步与语义召回 | 本轮未完整审阅两个适配器文件 |
| OV DSH memory bundle | 上游支持会话采集、召回、commit、MCP、技能目录 | 保留配置与 peer 接线不证明本机已经成功加载 |
| OV Server | 接收资源与记忆处理/检索请求 | health 200 不证明抽取、索引和召回完成 |

## 二、DSH 插件功能和制作方法
DSH 使用 Cordis：模块通过 apply 注册能力；inject 声明所需服务；工具通过 registry 接入。可扩展工具、服务、生命周期、模型/上下文贡献和其他能力，具体可用面取决于所装插件。[S06][S07]

制作步骤：
1. 确定能力归属。持久化事实/权限在工坊，Agent 操作与规则在小说 bundle。
2. 使用项目已有 .mjs 形式实现 name/inject/apply，注册工具参数、返回值与异常处理。官方 typed helper 可选，不必为其引入新栈。
3. 在 package.json 声明 dsh.bundle.patch，由 patch 插入模块；开发 overlay 路径按 DSH 实际解析规则配置。
4. profile 引用 bundle。工坊已有接线器维护 bundle 列表和源目录链接，不能另写一份会漂移的代码副本。
5. 更新 manifest/Host Contract/测试清单，核验最终请求中的 persona/规则和真实工具循环。
6. 安装、升级、卸载、取消与错误都在隔离 profile 验证，不污染用户全局配置。

Plugin、Tool、SKILL.md、Bundle、Profile 不是同一概念：
Plugin 是执行扩展；Tool 是模型可调用能力；SKILL.md 是规则/知识资产，不因文件存在自动执行；Bundle 是包及补丁组合；Profile 决定实际加载组合。

## 三、工坊内小说插件的实际形态
当前可读 package.json 将 novel-writing 声明为标准 DSH bundle，版本 0.10.0，入口 novel-tools.mjs，补丁 cordis.patch.yml。[S03]
Host Contract 为 1.2.0；工具面已扩展至23，端点至44。正文中部分旧“15工具/26端点”表述尚未同步，不能用旧数量验收。[S01][S04]
这些是不同组件版本，不能把应用版本、插件版本与 Host Contract 版本混为一谈。

### 不能被工具名称误导
- novel_review 的职责是登记审稿报告；模型生成报告与工具保存报告是两件事。
- novel_write_pipeline 当前返回写作简报，不生成正文，更不自动完成整条提交流水线。
- novel_state_commit 已有状态提案应用/快照机制，不等于前端的正文+旧提案采纳已经整体原子化。
- AUTHOR_KNOWLEDGE / CANON_KNOWLEDGE / CHARACTER_KNOWLEDGE 不可未经语义验证直接对应成作者/读者/角色三者。[S04]

### Skill 接入限制
小说 patch 禁用 tool-skill、skill、skill-filesystem，保留 OV 记忆插件的意图明确。[S05]
因此，直接把 Humanizer 放进 ~/.dsh/skills 不足以证明工坊会使用它。
与此同时，OV bundle 自身又支持技能目录/MCP能力。[S09]
最终应检查实际组合依赖与请求；既不能假定所有标准 Skills 自动可用，也不能简单说 DSH 完全没有技能能力。

### 安装/版本漂移
headless profile 的接线器以源目录 junction 代替复制；其 HOME 解析优先专用环境与 ~/.dsh-novel，避免写入运行时不用的位置。[S08]
GUI preset 的历史安装方式存在复制来源，须按实际安装器核验；不能从 headless“无副本”推导 GUI 也没有漂移。[S12]
需要同时对账源代码、实际模块、GUI preset、manifest、persona与规则内容哈希。

## 四、OpenViking 调用情况：两条接入链，不能混同

### 1. 小说长期记忆工具
novel_memory_read/update 经 Host Contract 访问宿主的长期记忆、提案与护栏。
其数据归宿不是自动等同 OV；插件没有理由直接读 novel.db。

### 2. 工坊作品资源同步/检索
ai-core 文档说明 OV 语义检索进入宿主“相关记忆检索”层，并有同步与缓存失效信号。[S02]
ov_indexed_at:<workId> 是 app_settings 的键值，不是 works 列。
该值只说明同步运行过，不能证明资源目录存在、有内容或可检索；要验证 works.ov_uri 对应资源和实际召回。
本轮未完整取得 openviking.js/openviking-sync.js，不能进一步保证每个具体 HTTP 端点与重试分支。

### 3. DSH 会话记忆
harness.js 确认将 OPENVIKING_PEER_ID 交给子进程环境；默认以工坊目录派生，目的是避免 headless cwd 位于 DSH 仓库而记入错误 peer，并实现预期的 GUI/headless 共享。[S10]
上游 OV bundle 支持 profile/index 注入、每步召回、会话事件采集、阈值 commit、pending重放及 MCP代理。[S09]
这说明“DSH 记忆完全与工坊无关”不正确，但尚未证明用户本机 bundle 已安装且服务端处理成功。

### 4. 必须解决/验证的边界
共享 peer 不是书籍隔离；上游默认 recallPeerScope=all 也不意味着只搜索当前作品。改成 actor 若两本书仍同peer，仍不能独立证明不串书。
应区别全局作者偏好、作品专属事实、DSH会话和候选草稿；候选可以保留为历史，但不能召回后冒充正史。
“重建作品投影”不得删除作者手写长期记忆、其他作品、DSH会话、用户偏好或共享技能。

### 5. 当前上游资料的版本差异
bundle README说明主召回使用 POST /api/v1/search/search，mode=context；recallMaxTokens控制主请求，而recallTokenBudget主要用于降级路径。[S09]
官方集成页与源码仓README对syncTurns=false时是否继续重放已排队写入，描述存在差异。[S09][S11]
因此必须锁定实际插件版本检查实现，不能按网页标签承诺“完全只读”。
OV服务端、memory bundle和DSH的兼容版本需分别记录，不能只记一个版本号。

### 6. 真正的双闭环验收
作品链：唯一测试哨兵 → 同步 → 索引完成 → 限定作品检索 → assembled召回层 → 最终请求。
会话链：实际DSH会话采集 → commit → 服务端抽取完成 → 新会话召回 → 最终请求。
HTTP 200、健康检查、工具已注册、索引时间戳都不能替代这两项。
本轮未执行上述运行测试。

## 五、差距表

“已证实缺口”只限定于以下可读路径，不推断整个仓库所有入口；“待验证”不能写成已发生故障。

| ID | 判定 | 证据/问题 | 实施方向 |
|---|---|---|---|
| G01 | 已有，复用 | 契约、事实、知识、预检、校验、提案、快照存在 | 补实际UI/流程/证据，不另建状态内核 |
| G02 | 已有，保留 | 直连+DSH默认路由、现有模型策略 | 同模型不同思考，新任务沿用原抽象 |
| G03 | 已证实缺口 | 整章编辑/审稿目标正文仍有6000/12000字符截断 | 目标覆盖与分片，不改原上下文预算 |
| G04 | 已证实缺口 | mergeReviewDiff先chapter_save，再独立且未await提案采纳 | 一次作者操作的宿主原子提交 |
| G05 | 已证实缺口 | novel_state_commit未知action会落入apply分支 | 枚举白名单与负向测试 |
| G06 | 已证实风险路径 | 包含型anchor替换整段，空patches返回null走失败逻辑 | 唯一定位、版本绑定、合法no-op |
| G07 | 待运行验证 | 批准是否在宿主强制、是否可跨作品或重放 | 绑定具体对象/版本/操作的授权 |
| G08 | 待运行验证 | DSH共享peer与跨作品/候选事实污染 | 来源、状态、范围与as-of检索隔离 |
| G09 | 待运行验证 | 宿主manifest之外OV/DSH追加上下文 | 在既有trace加最终贡献记录 |
| G10 | 配置事实+运行待验 | 通用Skill加载被关闭；OV有另一套目录贡献 | 扩现有bundle，不另造registry |
| G11 | 已有，需对账 | 专用profile、源链接、GUI preset路径 | 安装与真实加载版本一致性 |
| G12 | 已证实命名未改 | 用户界面仍为SillyTavern | 创作上下文改名与旧session兼容 |
| G13 | 未证实完整实现 | 首页致谢、三档编辑、样文档案、三级意图 | 本地全仓核验后补齐正式产品链 |
| G14 | 未证实完整实现 | 剧情多候选与按题材能力 | 宿主候选保存+现有DSH领域能力 |
| G15 | 已有基础，增强 | 原有导入已覆盖TXT/Markdown/EPUB | 加AI状态重建，不重做/降级导入 |
| G16 | 已有部分，范围待验 | 同步门闸、缓存失效、已有恢复设施 | 补作品投影retry/replay/rebuild，不删DSH记忆 |
| G17 | 未执行运行验收 | 本轮无真实DSH/DeepSeek/OV运行证据 | 隔离离线、浏览器、真实模型、OV双闭环分别验证 |

G03/G04/G06/G12/G15依据本次可读public/app.js；G05依据novel-tools.mjs。[S04][S13]
G07为必要的权限核验，不是本轮已经证实的宿主漏洞。
G13/G14不能因单个文件搜不到名称就判全仓不存在；实施时必须找等价能力，避免重复建设。

## 六、此前借鉴方向的正确落点
Humanizer：增强现有scan/style_contract/review及编辑纪律。
InkOS相关需求：协同采纳、作者意图、语义观察和候选剧情；不并入另一个core。
webnovel-writer相关需求：检验已有流程/事务/投影恢复；不复制另一套Gate/任务状态机。
Oh Story相关需求：补披露时点与状态导入；不引入_tracking-state.json或硬12KB第二上下文系统。
七项创作Skill的功能可作为现有bundle的可选profile实现，不强求七个独立运行插件。

## 七、交付提示词如何调整
配套 `novel_studio_codex_full_delivery_prompt.md` 包含12个必做实施包：
R01插件运行与对账；R02工具/权限/补丁边界；R03协同采纳事务；R04OV双链路；
R05最终上下文贡献追踪；R06命名和首页致谢；R07小说编辑/审稿/题材能力；
R08全文处理；R09样文/文风/意图；R10契约和知识流程增强；R11剧情沙盘；R12导入状态重建。

全部正式实现，默认门控保护旧作品；必须实际运行验证，但真实环境阻塞不得伪造PASS。
模型/思考策略/默认路由/原上下文预算不变。付费实测单列、有限预算、原创夹具、隔离记忆，避免为了测试写入用户生产库。
审计报告不能代替最终本机验收。

## 八、官方来源索引
以下均为本轮使用的官方仓库或官方文档，分支URL可变；实施时应换成实际SHA永久地址。

[S01] 工坊Host Contract
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/docs/host-contract.md`

[S02] 工坊AI内核与OV同步/召回说明
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/docs/ai-core.md`

[S03] 小说bundle包定义
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/harness-plugins/novel-writing/package.json`

[S04] 小说工具实际实现
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/harness-plugins/novel-writing/novel-tools.mjs`

[S05] 小说bundle patch
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/harness-plugins/novel-writing/cordis.patch.yml`

[S06] DSH首个插件教程
`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/index.md`

[S07] DSH工具开发规范
`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/adding-a-tool.md`

[S08] 小说bundle profile接线器
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/harness-plugins/novel-writing/install-profile.mjs`

[S09] OV DSH memory bundle官方README
`https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/dsh-memory-plugin/README.md`

[S10] 工坊DSH启动器及共享peer
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/harness.js`

[S11] OV官方DSH集成页
`https://docs.openviking.ai/en/agent-integrations/17-dsh`

[S12] 工坊小说插件README
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/harness-plugins/novel-writing/README.md`

[S13] 工坊前端源码
`https://raw.githubusercontent.com/bbaz123/novel-studio/refactor/p0-p6/public/app.js`

许可证单独核验：本次DSH根LICENSE为MIT；OpenViking main根LICENSE为AGPLv3。
子包/examples与实际部署版本仍需分别读取LICENSE，不能将根许可证外推所有组件。
`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/LICENSE`
`https://raw.githubusercontent.com/volcengine/OpenViking/main/LICENSE`
