# Novel Studio 小说工坊 · 全流程全结构代码审查报告

审查日期：2026-09-06
审查范围：仓库全部代码文件（server.js / db.js / harness.js / openviking.js / openviking-sync.js / logger.js / zip-reader.mjs / public/* / harness-plugins/novel-writing/* 全部文件 / 启动脚本 / 配置清单 / 运行时日志）
审查方式：四个独立深审通道逐行精读全部源码（read 工具全量覆盖，零跳读）+ 主审独立交叉验证（端点↔路由↔表结构对账、运行时日志取证、关键发现逐条复核行号与证据）。全程只读，未修改任何代码。

问题编号约定：
  [S-xx] server.js          [F-xx] 前端 app.js/index.html/styles.css
  [DB-xx] db.js             [HA-xx] harness.js
  [OV-xx] openviking.js     [OS-xx] openviking-sync.js
  [LG-xx] logger.js         [P-xx]  harness-plugins/novel-writing/
  [Z-xx]  基础设施与跨模块（主审独立核实）

----------------------------------------------------------------------
一、总体结论
----------------------------------------------------------------------

共发现 161 个问题：严重 3 · 高 7 · 中 47 · 低 104。
按模块分布：server.js 35 · 前端 45 · AI/记忆/日志/DB 四模块 50 · harness 插件 23 · 基础设施与跨模块 8。
无「必须立即停止使用」的崩溃级缺陷；但有 3 个严重问题会导致用户数据静默丢失（前端两处竞态、OpenViking 队列丢失更新），建议优先修复。

最优先处理（严重 + 高，共 10 条）：
  1. [F-01] 严重：编辑器自动保存定时器与章节切换竞态 → 800ms 内输入的正文静默丢失
  2. [F-02] 严重：快速切换作品时旧作品数据迟到写回覆盖新作品 state → 数据错乱
  3. [OV-01] 严重：OpenViking 离线队列 drain 与入队的丢失更新竞态 → 同步内容永久丢失
  4. [HA-02] 高：harness 超时路径只杀直接子进程，Windows 下 dsh 孙进程存活继续运行并可回写工坊
  5. [HA-06] 高：spawn(shell:true) 回退路径将 prompt 拼入 cmd 命令行，存在命令注入面
  6. [F-03] 高：章节正文/AI 写回内容未经消毒直接 innerHTML 渲染（存储型 XSS 面；导入路径经核实已转义，残余风险在粘贴与 chapter_save 通道）
  7. [F-04] 高：insertAIDraft 对 AI 输出未转义即拼 HTML（同族 XSS + 特殊字符破坏正文结构）
  8. [F-05] 高：历史版本预览渲染未转义的 v.content
  9. [F-06] 高：词条搜索框每次击键重建输入框 → 焦点丢失，功能近乎不可用
  10. [F-08] 高：章节保存无版本前置条件，多标签页并发编辑静默互相覆盖

值得肯定：SQL 全部参数化、通用 CRUD 表名白名单、CORS 收紧、事务纪律良好、零依赖架构清晰、日志/卡顿/慢操作主动监测体系完整、冒烟测试覆盖 30 组断言。详见本报告「四、亮点」。

----------------------------------------------------------------------
二、A. 结构概览
----------------------------------------------------------------------

【server.js · 2805 行】HTTP 服务与全部 API 路由
  - 1-45：导入/常量（MIME、PORT）；32-45：sendJSON/sendError
  - 47-61：写请求跨源防护 isLocalRequest；63-90：readBody（32MB 限长、JSON 解析）
  - 92-151：getPath/parseId/now、预编译语句缓存、上下文装配缓存（版本号失效+LRU）、touchWork
  - 153-238：通用 CRUD 元数据（RESOURCE_CONFIG/NUMERIC_FIELDS/insertRow/updateRow/deleteRow）
  - 240-315：关键词检索 search；317-470：AI 层（callAI/URL 回退/getConfigFromBody/AI 错误历史）
  - 472-503：章节手动存档版本；505-596：文本工具、长期记忆
  - 598-730：出场角色评分选择与角色卡构建；732-806：UI 预览上下文 buildAIContext
  - 808-980：写作红线（种子/列表/替换/扫描）；982-1123：故事事件账本、入账提案、记忆版本回滚
  - 1125-1375：完整创作上下文装配 buildNovelContext（分层预算+语义召回+缓存）
  - 1377-1408：章节审稿；1410-1519：TXT/MD/EPUB 导入；1521-1564：导出
  - 1566-1704：示例小说安装；1706-1941：AI 自动创建小说
  - 1943-1996：Harness 后台任务队列；1998-2730：路由总入口 handleAPI
  - 2732-2761：静态服务与 SPA 回退；2769-2805：HTTP 服务器、统一异常捕获、慢请求监控、启动索引

【db.js · 339 行】SQLite 初始化与建表
  1-16：打开 DatabaseSync（WAL、foreign_keys=ON）；18-288：建 20 张表；290-309：旧库 ALTER 补列；311-339：约 26 个索引

【harness.js · 392 行】DeepSeek Harness 桥接
  1-45：dsh 仓库/设置路径解析（含 2 处硬编码桌面绝对路径）；60-133：pnpm 定位与构建；135-167：settings.yaml 模型补丁；169-195：错误可读化与进程树强杀；197-382：withModelSwitch 互斥 + 任务运行（四路 settle）；384-392：包装

【openviking.js · 303 行】OpenViking 客户端
  48-83：凭证解析链；85-224：HTTP 客户端（信封/超时/健康检查/读写删查）；228-263：离线 pending 队列（JSONL，同 URI 合并）；269-300：队列重放（health 门控、3 次尝试上限）；302-303：45s 重放定时器

【openviking-sync.js · 542 行】OpenViking 同步层
  30-64：app_settings 与语义开关；66-95：URI 助手与 htmlToPlain；97-193：六类数据渲染器（章节/记忆/事件/大纲/词条/角色/世界观 → Markdown）；195-298：notifyChange 2s 防抖调度；300-384：全量收集/分片/同步/删除；386-410：启动补索引；412-542：语义召回（30s 缓存、阈值 0.3、top8）与检索合并

【logger.js · 464 行】统一日志系统
  62-110：语句缓存与调用栈解析；112-137：文件+SQLite 双写（均为同步 I/O）；139-217：log()（去重/归一/截断）；219-258：timed/timedAsync 慢操作；260-295：事件循环滞后监测；297-332：进程兜底；334-361：保留策略；363-419：查询/清空；421-443：旧 AI 错误迁移；445-464：初始化

【public/app.js · 6415 行 + index.html 48 + styles.css 1163】前端单页应用
  1-89：状态与视图路由；91-171：日志上报、api() 封装、全局错误与卡顿监测
  328-497：数据加载（11 路并行）、渲染分发、会话恢复；499-617：日志面板
  999-1122：写作页与编辑器事件；1221-1380：自动保存/手动保存/历史版本
  1471-1706：设定词条/角色/SillyTavern；1708-1957：长期记忆与提案
  2136-2403：AI 创作首页与 harness 任务轮询；2405-2738：创作流水线
  2987-3443：AI 上下文与写作蓝图协议；3590-3739：段落 diff 与审稿修稿闭环
  3797-4073：AI 写作结果应用与批量章节生成；4240-5003：设定类 AI 生成器与自动创建
  5058-6179：全局事件委托（约 120 个 action）；6181-6415：搜索/初始化

【harness-plugins/novel-writing/】内置创作插件（v0.8.0）
  novel-tools.mjs 534 行：13 个 novel_* 工具的 dsh 侧实现（jfetch 严格客户端+统一上报）
  smoke.mjs 724 行：23 组 HTTP 冒烟断言（临时数据目录+随机端口+清理）
  plugin.json 54 行：清单（工具/端点/契约）；agent.cordis.yml 53 行 + preset.yml 2 行：GUI preset
  headless-cordis.patch.yml 37 行：headless 注入区块；install.ps1 183 行：合并式安装/升级/卸载
  README/ENGINE/NATIVE_PLUGIN_GUIDE：文档

【基础设施】zip-reader.mjs 52 行（零依赖 ZIP 读取）；start-novel-studio.cmd 26 行；create-desktop-shortcut.ps1 17 行；novel-studio-icon.ps1（GBK 编码）；package.json 13 行

----------------------------------------------------------------------
三、B. 问题清单
----------------------------------------------------------------------

==================================================
3.1 server.js（35 条）
==================================================

[S-01] 中 · 异常流程/一致性 · server.js:65-90、2058-2059、2633、2682、2724-2726、2786
  问题：readBody 的拒绝错误在不同路由落到不同状态码且无统一 413。证据：/api/import（2059 readBody 在 try 外）、/api/story_memory（2170）、/api/novel/events（2272）的解析错误冒泡到最外层 2786 `sendError(res, 500, e.message)`；通用 CRUD（2682 在 try 内，2724-2726 → 400）与 /api/ai（2633 → 400）返回 400。另 69 行 `req.destroy()` 后错误继续上抛，路由继续向已销毁 socket 写响应。
  影响：前端无法统一区分「请求过大/JSON 错误」与「服务器故障」；超限请求产生噪声日志。
  建议：readBody 错误附加 code（PAYLOAD_TOO_LARGE/INVALID_JSON），各路由统一映射 413/400。

[S-02] 中 · 正确性Bug · server.js:73-79
  问题：流式限长用 `data.length`（字符数）判断（76 行），而 `data += chunk` 把 Buffer 逐块转 UTF-8（75 行）：多字节中文实际字节数可达上限约 3 倍（≈96MB）才被拒；跨 TCP chunk 边界拆分的多字节字符被逐块解码成乱码。
  影响：32MB 内存上限实质性失效；大 JSON 正文中的中文偶发损坏。
  建议：用 Buffer 累计 byteLength，整体 toString('utf8') 后再 JSON.parse。

[S-03] 中 · 正确性Bug/一致性 · server.js:219-231、2696-2721
  问题：PUT 不存在 id 时 updateRow 影响 0 行仍返回 true（229-230），路由返回 200 且 row 为 undefined → `res.end(undefined)` 空响应体；DELETE 不存在 id 也返回 200 {ok:true}；而 GET 不存在是 404（2679）。三种方法契约不一致。
  影响：前端解析空 200 报错；「删不存在的作品」被静默当成功，掩盖调用方 bug。
  建议：PUT/DELETE 前查存在性返回 404，或用 run().changes 判断影响行数。

[S-04] 低 · 异常流程 · server.js:100-103、2004、2670-2675
  问题：parseId('12abc') 返回 null 后，GET /api/works/12abc 落入 `method==='GET' && !id` 分支返回全量作品列表 200，而非 404。
  影响：畸形 URL 返回语义错误的数据。
  建议：`segments[2] && !id` 时单独返回 400/404。

[S-05] 中 · 安全 · server.js:167、2675-2679、2452-2456
  问题：GET /api/api_configs（列表+详情）原样返回 api_key 明文列（RESOURCE_CONFIG 167 行 fields 含 api_key，getList SELECT *），且 GET 不受 Origin 校验（2007 只拦写方法）；GET /api/harness/status 返回本机绝对路径 HARNESS_DIR（2456）。
  影响：本机任意进程/页面可读走 API Key；路径信息泄露。
  建议：列表接口对 api_key 掩码；HARNESS_DIR 改为布尔值或移除。

[S-06] 低 · 安全/健壮性 · server.js:47-61、2007
  问题：isLocalRequest 只校验 Origin 主机名属于 {localhost,127.0.0.1,::1}，不校验端口，也不校验 Host 头；本机其它端口网页的写请求均能通过。
  影响：防护依赖「本机无其它 Web 服务」假设。
  建议：加 Host 白名单，或引入启动生成的本地令牌随 UI 请求校验。

[S-07] 中 · 异常流程（需运行时验证）· server.js:2743-2748
  问题：serveStatic 中 fs.stat 成功后再 createReadStream().pipe(res)，read stream 无 error 监听：stat 与 open 之间文件被删（TOCTOU）→ uncaught exception 崩溃全进程；res 侧错误同样无处理。
  影响：低概率但后果为全进程崩溃。
  建议：stream.on('error') 与 res.on('error') 兜底并记日志。

[S-08] 中 · 异常流程 · server.js:1964-1968、2485-2489
  问题：harnessJobs.size > 30 时无条件删除 Map 最旧条目，不判断其状态；运行中的任务被淘汰后 GET /api/harness/job 404、无法取消，但 dsh 子进程与异步链继续运行至结束，结果不可达。
  影响：第 31 个任务开始，最早仍在跑的任务对用户「消失」且不可取消。
  建议：只淘汰终态任务；运行中任务先 abort 再删除。

[S-09] 中 · 健壮性 · server.js:2463-2483、1948-1995
  问题：POST /api/harness/run 无并发上限，每次请求 spawn 一个 dsh 子进程；harnessJobs 30 条仅限元数据，不限制任务本身。
  影响：故障循环或恶意脚本可刷出大量子进程拖垮机器。
  建议：并发上限（如 ≤2）超出 429，并做提交频率节流。

[S-10] 低 · 健壮性 · server.js:2476
  问题：`timeout: Number(body.timeout) || 10*60*1000` 对客户端 timeout 无上限钳制，可提交 1e12ms 产生近乎永久的后台任务。
  影响：配合 S-09 放大资源占用。
  建议：钳制 timeout ≤ 60 分钟并拒绝非整数。

[S-11] 低 · 正确性Bug · server.js:845-857、901、2764
  问题：seedRedlinesIfEmpty 以「全局红线计数为 0」判未初始化（846-847），而 PUT /api/novel/redlines（work_id 为空 + entries:[]）合法地删除全部全局红线（901）。用户清空默认红线后，下次启动全部重新灌入 29 条。
  影响：用户设置被静默回滚。
  建议：用 app_settings 记录「已初始化红线」标志替代计数判据。

[S-12] 中 · 正确性Bug · server.js:123-151、2249-2259、2589-2614
  问题：/api/novel/context 缓存仅靠 touchWork 失效，两处写路径漏 bump：① POST /api/chapter_versions/:id/restore 直接 UPDATE chapters（2600-2605）只 notifyChange 不 touchWork；② PUT /api/novel/redlines 全局模式（workId 空）时 2254 `if (workId) touchWork(workId)` 被跳过，而全局红线影响所有作品缓存。
  影响：恢复版本后上下文继续返回旧正文 story_tail；改全局红线后风格契约仍是旧内容。
  建议：restore 路由补 touchWork(chapter.work_id)；全局红线 PUT 无条件 touchWork。

[S-13] 中 · 正确性Bug · server.js:1210-1213
  问题：大纲省略数学错误：`skip = total > 80 ? total - 40 - 30 : -1` 即 total-70，过滤 `i < 30 || i >= skip`（1212）实际展示前 30 + 后 70 = 100 章。total=100 时 skip=30、`i<30||i>=30` 恒真一章未省，却仍输出「（中间 30 章已省略…）」（1213）；注释（1206）写「前 30 + 最近 30」与实现不符。
  影响：长作品大纲实际塞入 100 章标题/摘要，挤占 token 预算；省略文案与事实不符。
  建议：改为 `skip = total > 70 ? total - 40 : -1`（前 30+后 40），或显式「首 N+尾 M」并同步文案。

[S-14] 低 · 异常流程（竞态）· server.js:993-1004
  问题：addStoryEvent 的 dedup_key 查重（995-998）在 BEGIN 事务（999）之前，check-then-insert 非原子；且 db.js 对 (work_id,dedup_key) 只有普通索引（idx_story_events_dedup，330 行）无 UNIQUE 约束。并发同 key 请求可重复入账。
  影响：重复事件入账（插件并发调用时存在）。
  建议：查重与插入同事务，或建唯一索引并捕获冲突。

[S-15] 低 · 正确性Bug · server.js:318-323、396-406
  问题：callAI URL 回退构造缺陷：base 以 /chat/completions 结尾时 chatCompletionsUrl 原样返回（320），回退 alt = `${base}/v1/chat/completions`（401）得到 `.../chat/completions/v1/chat/completions` 畸形 URL；402 行 alt===primary 保护只覆盖 base 以 /v1 结尾情形。
  影响：该配置下触发回退时向畸形地址多发一次必失败请求。
  建议：在 chatCompletionsUrl 归一化 base（先剥离 /v1 与 /chat/completions 尾缀再拼接）。

[S-16] 中 · 正确性Bug/兼容性 · server.js:1466-1498
  问题：parseEpub 用正则解析 OPF：`<item[^>]*\bid=["']...`（1477）不匹配 `<opf:item>`（OPF 2.0 常见）；正则要求 id 在 href 之前（1477），属性顺序颠倒即失败；full-path（1470）不做 XML 实体解码；spine 同样受命名空间影响。
  影响：相当一部分真实 EPUB 导入失败或丢标题。
  建议：宽松匹配 `[\w:]*item`、分别捕获 id/href 组装、full-path 做实体解码与规范化。

[S-17] 中 · 正确性Bug · server.js:507-513、1538-1550、1562
  问题：plainText 把所有空白 `\s+` 压成单空格（509-511），而导出 buildWorkExport（1538/1549）与 buildChapterExport（1562）用它转换正文：`<p>段落A</p><p>段落B</p>` 变成一整行字墙。仓库内已有保留段落边界的 htmlToPlain（1440-1453）未被导出使用。
  影响：导出的整书 TXT/Markdown 失去全部段落结构，核心功能输出质量受损。
  建议：导出改用 htmlToPlain 或按块级标签换行的专用转换。

[S-18] 低 · 一致性 · server.js:1456-1463、1583-1592
  问题：textToHtml 对 & < > 转义（1461），demoToHtml 是重复实现且完全不转义（1586-1591），「以 < 开头就原样保留」。
  影响：两份逻辑分叉，示例数据若含 <script> 文本会原样入正文。
  建议：删除 demoToHtml 统一走 textToHtml。

[S-19] 中 · 一致性 · server.js:733-806 vs 1127-1364
  问题：buildAIContext 与 buildNovelContext 两套平行装配实现已分叉：世界观词条前者无 30 条上限（761-765）、后者有（1194-1204）；大纲/蓝图/分层预算/语义召回只在后者存在。
  影响：UI 预览与插件实际使用的上下文不一致，用户看到的与 AI 拿到的不一样；改规则需双份同步。
  建议：合并为单一装配函数，buildAIContext 作为轻量子集。

[S-20] 低 · 低效代码 · server.js:2124-2130
  问题：/api/ai_context 中 buildAIContext 已加载章节行（2124），2129 行又按同一 chapter_id 重新 SELECT 一遍仅用于语义召回。
  影响：每次请求多一次冗余查询。
  建议：让 buildAIContext 返回章节行或复用 ctx.chapter。

[S-21] 低 · 低效代码 · server.js:583、587
  问题：compressStoryMemory 一次 SELECT 拉取全部章节完整 content 大字段（583），每章实际只用前 500 字（587）。
  影响：大作品同步加载数十 MB 正文再丢弃，阻塞事件循环。
  建议：查询排除 content，改用 substr(content,1,1500) 或分批取头部。

[S-22] 中 · 低效代码（需大数据量验证）· server.js:249-255、273-312
  问题：search 对四类表执行 `LIKE '%kw%'` 全表扫描且 SELECT *（含正文大字段）LIMIT 200（249-255），随后 JS 逐行 plainText 剥标签排序，全程同步阻塞（2013 timed 只记录耗时）。无 FTS 无可用索引。
  影响：章节多时一次搜索阻塞事件循环数秒，期间所有请求卡住。
  建议：引入 SQLite FTS5，或限制 LIKE 扫描字段范围，搜索异步化/降级。

[S-23] 中 · 安全 · server.js:885-893、941-980、2260-2265
  问题：scanAgainstRedlines 对用户配置的 regex 仅校验「可编译+长度≤500」（892）即直接执行 `clean.match(re)`（958-959）作用于最大 32MB 文本（2263）。病态正则（如 (a+)+$）造成灾难性回溯，无超时机制，同步阻塞事件循环（ReDoS）。
  影响：本机任何客户端可通过 PUT 红线 + POST scan 让服务长时间假死；AI 正文触发扫描同样有风险。
  建议：正则安全检测（嵌套量词/长度）、限制扫描文本长度、扫描移入子进程或带超时。

[S-24] 低 · 健壮性 · server.js:2548-2568
  问题：POST /api/logs 的 context 对象直接透传存储（2566），无深度/键名长度/值大小限制（仅受 32MB 请求体上限）。
  影响：日志表可被写入数十 MB JSON，长期膨胀拖慢 SQLite。
  建议：context 序列化后大小上限（如 8KB）+ 键名白名单。

[S-25] 低 · 低效代码/健壮性 · server.js:110-118、1077-1078、1183-1185
  问题：stmtCache 无上限无淘汰；settleProposals 与 buildNovelContext 按占位符数量生成不同 SQL 字符串（`id IN (${list.map(()=>'?')})`），ids 长度千变万化时每个长度永久驻留缓存。
  影响：长期运行缓存缓慢增长。
  建议：容量上限（如 500）超限清空；动态 IN 列表用不缓存的临时 prepare。

[S-26] 中 · 正确性Bug · server.js:159、219-231、1139-1148、2302-2315
  问题：资源归属不校验：通用 CRUD 允许把 chapter.volume_id/plotline_id/work_id/parent_id 设为另一作品资源 id（FK 只保证行存在）；buildNovelContext 对 chapterId 不在 allChapters 时回退 SELECT 后照常用于装配（1141），可把别作品章节混入当前上下文；POST /api/novel/events 的 resolves_event_id（2281）与伏笔状态更新的 resolves_event_id（2310-2312）不验证目标事件存在且为伏笔。
  影响：跨作品数据污染 AI 上下文（写串作品）、伏笔回收指向不存在/错误事件。
  建议：写入时校验引用 id 与 work_id 归属一致；buildNovelContext 对 chapter.work_id!==workId 返回 null；resolves_event_id 校验 kind='foreshadow' 且同作品。

[S-27] 低 · 一致性 · server.js:540-545、1118-1123
  问题：rollback 到与当前相同版本时 saveStoryMemory 走 unchanged 提前返回（543-545）无 version_id，rollbackMemory 原样透传 → 响应缺 version_id 字段。
  影响：前端依赖 version_id 时契约不稳定。
  建议：unchanged 分支补当前最新版本 id。

[S-28] 低 · 正确性Bug · server.js:1094-1099
  问题：提案采纳时 summary 与 delta 均为空则 saveStoryMemory(workId,'') 把长期记忆覆盖为空串并新增空版本快照。
  影响：异常提案（AI 输出空）即可「清空」长期记忆。
  建议：summary 为空跳过写入并计入失败；saveStoryMemory 禁止空摘要覆盖非空旧值。

[S-29] 低 · 低效代码/健壮性 · server.js:1770-1781
  问题：generateNovelFromPrompt 对任何错误（含 401 认证失败这类确定性错误）无条件重试一次，二次失败原始错误直接上抛。
  影响：认证类错误浪费一次付费调用；错误信息未经可读化。
  建议：仅对网络超时/解析失败重试；认证/参数错误直接抛并走 logAIError。

[S-30] 低 · 正确性Bug · server.js:2063-2065
  问题：`Buffer.from(String(body.base64),'base64')` 宽松解码：非法字符被静默忽略，损坏输入解出乱码而非报错，随后 parseEpub 报「缺少 container.xml」与实际原因脱节。
  影响：误导性错误提示，难以定位「文件损坏」真实原因。
  建议：先做 base64 合法性校验，失败返回 400「文件不是有效的 base64/EPUB」。

[S-31] 低 · 一致性（状态码误用）· server.js:2046-2047、2144-2145、2084-2085、2582-2587
  问题：demo/install 对「演示数据文件缺失」返回 409（应为 500）；story_memory/compress 对「作品不存在」返回 502（2144，应为 404）；import 对标题为空返回 500「写入失败」（2084，应为 400）；POST /api/chapter_versions 对不存在章节 FK 违约冒泡为 500（2582-2587 无 try/catch）。
  影响：状态码失去诊断价值。
  建议：输入校验 400、不存在 404、依赖服务 502、自身故障 500；chapter_versions POST 补存在性预检。

[S-32] 低 · 弃用代码 · server.js:2524-2527
  问题：POST /api/harness/stop 是纯占位端点，不执行任何操作，固定返回成功文案。
  影响：客户端得到「成功」假象，掩盖停止语义未实现。
  建议：删除，或改 410/501 明确未实现。

[S-33] 低 · 异常流程 · server.js:1674-1703
  问题：installDemo 在 COMMIT（1674）之后才执行 saveStoryMemory 与逐条 addStoryEvent（1676-1685），任一步失败异常上抛返回 409，但示例作品主体已提交。
  影响：留下「作品已存在但无记忆/事件」的半成品；重试撞「已存在」报错。
  建议：把记忆/事件写入纳入同一事务，失败整体回滚。

[S-34] 低 · 健壮性 · server.js:146-151
  问题：touchWork 静默吞掉所有 DB 错误（150 `catch (_) {}`）：缓存版本号已 +1，但 updated_at 更新失败不可见。
  影响：缓存失效与 updated_at 漂移时无任何线索。
  建议：至少记 warn 日志或让错误冒泡。

[S-35] 低 · 健壮性（需运行时验证）· server.js:410-411
  问题：getConfigFromBody 对 body.config_id 直接 Number(...) 查询，'abc' 得 NaN，node:sqlite 绑定 NaN 可能抛 TypeError，被 /api/ai catch 后以 502 + 底层 TypeError 文本返回。
  影响：错误信息暴露内部细节，状态码误导。
  建议：Number.isInteger 校验 config_id，非法返回 400。

==================================================
3.2 前端 app.js / index.html / styles.css（45 条）
==================================================

[F-01] 严重 · 异常流程（异步竞态+定时器未清理）· app.js:37、1000-1099、1221-1226、1360-1380、5386-5390
  问题：自动保存定时器与章节切换竞态导致未保存修改永久丢失。scheduleSave（1221-1226）只在输入时 clearTimeout+setTimeout(saveCurrentChapter,800)；renderWriting 重建编辑器 DOM（1077）时从不取消 state.editorSaveTimer；saveCurrentChapter（1360-1380）在触发时重查 $('#editor-content') 与 dataset.chapterId。证据：在 A 章输入 → 800ms 内点 B 章（open-chapter 5386-5390 只改 state 后 render）→ 编辑器重建为 B 章 → 定时器触发把 B 章内容 PUT 到 B 章 id（1371），A 章修改既没保存也没留存；切到非写作页时 editor 为 null 直接 return（1363），A 章修改同样丢失。
  影响：用户最核心创作场景的静默数据丢失。
  建议：切换章节/视图前先 flushSave（立即 saveCurrentChapter + clearTimeout）；或在 render 前统一取消定时器并保存；保存用闭包捕获发起时的 chapterId 与内容快照。

[F-02] 严重 · 异常流程（结果乱序写回）· app.js:336-361
  问题：loadWorkData 用 `const workId = state.workId`（339）发出 11 个并行请求，写回时 `Object.assign(state, {..., loadedWorkId: workId})`（353-357）未校验 state.workId 是否仍是发起时的值。快速切换 A→B 时，A 的慢响应晚于 B 返回，把 A 数据覆盖进 state，loadedWorkId 置为 A 的 id，缓存判断（338）失效，页面在 B 作品里展示 A 的数据。
  影响：作品间数据错乱，用户可能基于错乱数据保存/删除。
  建议：写回前 `if (state.workId !== workId) return;` 丢弃过期结果；配合请求序号或 AbortController。

[F-03] 高 · 安全(XSS) · app.js:1077、1367、2439（server.js）
  问题：章节正文未经消毒直接插入 innerHTML：`<div id="editor-content" ...>${current.content || ''}</div>`（1077）。经主审核实：TXT/MD/EPUB 导入路径入库前已过 textToHtml 转义（server.js:1509），该路径安全；残余风险在两条原始写通道：① 编辑器粘贴任意 HTML（浏览器对 onerror 等事件属性过滤不彻底）→ PUT /chapters/:id 存 editor.innerHTML 原文（1367）；② POST /api/novel/chapter_save 将 AI/插件提交的 content 原样 UPDATE（server.js:2439）。下次打开章节时事件属性即执行。
  影响：存储型 XSS（本机单用户+CORS 收紧使危害有限，但粘贴/导入不可信内容时是真实攻击面，可窃取 localStorage 会话数据）。
  建议：渲染前白名单消毒（仅允许 p/br/b/i/u/h2/blockquote/ul/ol/li/a[data-term-id]）；保存与 chapter_save 入库前同样兜底清洗。

[F-04] 高 · 安全(XSS) · app.js:4975-5003（关键 4980-4981）
  问题：`const html = paragraphs.map((p) => `<p>${p}</p>`).join('')` 对 AI 输出未转义即拼 HTML 插入编辑器。state.aiDraft 来自 AI 回复，可被写作指令/设定内容诱导输出 HTML 标签；同功能 textToParagraphsHtml（3152-3159）有 esc，此处遗漏。
  影响：AI 输出中 <img onerror> 在编辑器内执行；即使无恶意，<、& 也会破坏正文结构。
  建议：复用 textToParagraphsHtml 统一转义。

[F-05] 高 · 安全(XSS) · app.js:1437-1449（关键 1445）
  问题：历史版本预览直接插入未转义的 v.content：`<div class="version-preview">${v.content || ...}</div>`（1445）。v.content 与 F-03 同源。
  影响：与 F-03 相同的存储型 XSS 展示路径；即使编辑时未触发，版本预览仍可能执行。
  建议：与 F-03 统一渲染前白名单消毒，或预览退化为纯文本 esc。

[F-06] 高 · 正确性Bug · app.js:6261-6270（关键 6267）
  问题：设定库搜索框每次击键重建整个列表容器（含输入框自身）：`list.innerHTML = '<div class="mb-8"><input id="term-search" ...>' + 词条列表`（6267）。每输入一个字符旧 input 销毁、新 input 创建，焦点丢失，必须重新点击才能输入下一个字符。
  影响：词条搜索框无法连续输入，功能近乎不可用。
  建议：把 input 移出重建范围只重建列表子容器；对齐 character-search（6271-6282，重建范围不含 input）的写法。

[F-07] 低 · 一致性 · app.js:1365-1371、5371-5383、1976、5637、1963（经主审核实修正）
  问题：多个写路径以部分字段 PUT（saveCurrentChapter 只发 {title,content,summary} 等）。经主审交叉核实：后端 updateRow（server.js:219-231）仅更新 `data[f] !== undefined` 的字段，属部分更新语义，前端假设成立，不存在清空风险。残余风险：该语义未被任何文档/测试固化；null 会被 normalizeValue 转默认值，undefined 才表示「不更新」，前端隐式依赖这一差异。
  影响：无当前数据风险；维护者未来改动后端 PUT 语义即可能静默破坏正文。
  建议：在契约文档明确 PUT=部分更新（undefined=不更新）；补字段存在性测试用例。

[F-08] 高 · 正确性Bug（编辑冲突覆盖）· app.js:1360-1380、465-479
  问题：章节保存是无条件 PUT 覆盖，请求体不含版本号/updated_at 前置条件，后端无法检测冲突；persistSession 用 sessionStorage（467-477），每标签页独立会话，鼓励多标签页同章编辑。
  影响：并发编辑互相覆盖正文，数据丢失不可察觉。
  建议：保存携带读取时 updated_at（乐观锁），后端冲突返回 409 提示刷新；或 storage 事件跨标签页互斥提醒。

[F-09] 中 · 异常流程（结果乱序写回）· app.js:6192-6211
  问题：全局搜索 300ms 防抖后发起 fetch，无请求序号或 AbortController。快速改词时旧响应晚到覆盖新结果。
  影响：搜索结果与当前输入不符，可能点击错误条目跳错位置。
  建议：递增请求序号仅最新序号写 DOM；或 AbortController 取消旧请求。

[F-10] 中 · 异常流程 · app.js:2331-2350
  问题：runHarnessJob 轮询 `for(;;)` 每 1.5s 一次，无最大时长/次数上限，完全依赖服务端任务终态化。若服务端任务挂起（job 停留 running），客户端无限轮询，进度卡永不消失。
  影响：界面长时间卡「执行中」，无限累积轮询请求。
  建议：客户端总超时（任务 timeout+余量），超时提示并可尝试取消；轮询加退避。

[F-11] 中 · 正确性Bug/一致性 · app.js:1194、6205 vs 1190
  问题：语义召回相关度渲染为 `${Number(h.score) || 0}%`（1194、6205），而 1190 行注释「无命中（阈值 0.3）」暗示 score 是 0-1 小数。若 score=0.65，UI 显示「相关度 0.65%」而非 65%。
  影响：用户看到的召回相关度数值错误。
  建议：与后端确认 score 量纲（0-1 还是 0-100）统一换算展示。

[F-12] 中 · 低效代码 · app.js:891-931（关键 894-895、906）
  问题：renderNode 递归渲染时每节点调用 childrenOf（894）与 rootsOfVolume（895），两者均对 state.chapters 全量 filter。N 个章节的树整体 O(N²)。
  影响：章节数数百时大纲列表渲染明显卡顿。
  建议：先构建 parentId→children Map 一次，渲染 O(1) 查询。

[F-13] 中 · 正确性Bug（CSS 冲突）· styles.css:63、84-87
  问题：`.hidden { display:none !important; }`（63）使 `.sidebar.hidden { margin-left:-248px; }`（87）永不生效——display:none 立即隐藏，84 行 transition:margin-left 动画白写，侧栏折叠是瞬时跳变而非设计意图的滑动动画。
  影响：与代码意图（过渡动画）不符；!important 增加复用隐患。
  建议：侧栏独立类（如 .collapsed）+ transform/margin 动画。

[F-14] 中 · 正确性Bug（状态与 UI 不一致）· app.js:5230-5242
  问题：demo-install 的 toast 文案直接访问嵌套字段 r.counts.chapters 等（5231）；旧版服务端无 counts 字段时抛 TypeError 被 catch 捕获显示「导入失败」（5238），但示例数据实际已导入成功，且 state.workId 未设置。
  影响：用户看到「导入失败」实际数据已存在，再次操作可能重复导入。
  建议：用可选链 r.counts?.chapters 兜底；先设置状态再拼提示文案。

[F-15] 低 · 一致性 · app.js:112-113、3745-3747
  问题：两条路径错误口径不一致：api() 对非 JSON 响应 data={raw:text}、error 为空，最终只抛「请求失败 (500)」，后端错误细节被吞；downloadExport 反向把原始 HTML 切片 text.slice(0,200) 直接展示。
  影响：故障排查困难；导出失败时用户看到原始 HTML 片段。
  建议：api() 对非 JSON 提取可读文本（剥标签截断）；downloadExport 与 api() 统一错误格式。

[F-16] 低 · 一致性 · app.js:1371 vs 3727、4054
  问题：章节正文两条写入通道：编辑器走 PUT /chapters/:id，审稿合并与批量生成走 POST /novel/chapter_save。两条通道对 summary/updated_at/历史版本快照语义若不一致，行为取决于入口。
  影响：潜在数据行为不一致；维护成本高。
  建议：后端收敛单一保存通道，前端统一调用；或明确差异并写进契约文档。

[F-17] 低 · 弃用代码 · app.js:61-67
  问题：isSettingsView/isAIView 定义后全文件无调用点（grep 验证仅定义处出现）。
  影响：死代码。
  建议：删除，或改由 goView 使用。

[F-18] 低 · 弃用代码 · app.js:46
  问题：state.genContextCache 初始化后从未读写。
  影响：死字段。
  建议：删除。

[F-19] 低 · 弃用代码 · app.js:1534
  问题：renderCharacters 内 `const plotlineStates = state.plotlineCharacters.filter(...)` 定义后未使用；1591-1598 直接 find 渲染。
  影响：死变量 + 一次无谓全量 filter。
  建议：删除或改用该变量渲染。

[F-20] 低 · 弃用代码 · app.js:5293
  问题：`data.volume_id = undefined;` 无任何效果——JSON.stringify 会丢弃 undefined 键（见 107 行序列化逻辑），无效语句。
  影响：死代码，误导读者。
  建议：删除。

[F-21] 低 · 弃用代码 · app.js:313-316、230、243
  问题：setSidebar(false) 全文件无调用点，false 分支死代码；openModal 的 onMount 参数所有调用点均未传。
  影响：死参数/死分支。
  建议：删除参数或补充使用。

[F-22] 低 · 弃用代码 · app.js:6266-6268
  问题：`const oldDetail = list.innerHTML;`（6266）赋值后仅 `void oldDetail;`（6268），从别处复制粘贴的残留。
  影响：死变量，配合 F-06 说明该处理器需整体重写。
  建议：与 F-06 一并重写时删除。

[F-23] 低 · 弃用代码（重复函数）· app.js:1894-1926 与 3591-3623
  问题：diffSentences 与 diffParagraphs 是同一 LCS diff 实现的逐行拷贝（DP 表、回溯、超大输入降级逻辑完全相同），仅 split 正则不同。
  影响：维护成本翻倍，修复需同步两处。
  建议：抽取公共 diffTokens 核心，两函数只提供不同分词。

[F-24] 低 · 弃用代码（重复函数）· app.js:3446-3465 与 4387-4406
  问题：askAIWritingQuestion 与 askAIGenQuestion 几乎逐行相同（仅标题/placeholder 不同），且共用 state.pendingAIQuestion 槽位互不知晓。
  影响：重复维护；改协议只改一处导致行为分裂。
  建议：合并为带 title/placeholder 参数的单函数。

[F-25] 低 · 弃用代码（重复函数）· app.js:4975-5003 与 3177-3199
  问题：insertAIDraft 与 insertHtmlAtCursor 实现相同光标/选区插入逻辑，insertAIDraft 是旧版且未转义（见 F-04）。
  影响：重复实现 + 安全差异。
  建议：删除 insertAIDraft，统一走 insertHtmlAtCursor + textToParagraphsHtml。

[F-26] 低 · 弃用代码/正确性Bug · app.js:309-311 与 3409-3411
  问题：wordCount 先 stripHtml 再计数，plainLength 不剥标签只去空白，口径不一致。批量生成/续写补足（3931、4046）用 plainLength，编辑器计数用 wordCount，同一篇文章两处数字对不上（AI 返回带 <p> 文本时 plainLength 多算标签字符）。
  影响：字数提示不一致（目标字数判断偏差）。
  建议：统一为一个函数。

[F-27] 低 · 低效代码 · app.js:1005-1027
  问题：treeHTML 对每个卷调用 rootsOfVolume（1006，全量 filter chapters），「未分卷」列表再 filter 一次（1024）。
  影响：章节多时目录构建多次全量扫描。
  建议：与 F-12 共用预构建索引。

[F-28] 低 · 低效代码 · app.js:1492、1591-1598
  问题：renderTerms 每分类渲染 terms.filter 计数量（O(分类数×词条数)）；renderCharacters 每条剧情线 state.plotlineCharacters.find。
  影响：数据量大时渲染变慢。
  建议：预计算分类计数 Map 与 (plotline_id,character_id)→记录索引。

[F-29] 低 · 低效代码 · app.js:900、966
  问题：大纲页每个章节节点渲染调用 wordCount → stripHtml，创建临时 div 解析整章 HTML。
  影响：每章数千字时大纲页渲染大量 DOM 解析。
  建议：服务端章节列表返回 word_count 字段，或前端缓存。

[F-30] 低 · 低效代码 · app.js:624
  问题：renderWorks 每次渲染同步 `await api('/demo/status')`（624）无缓存，阻塞作品列表首屏。
  影响：每次多一次网络往返。
  建议：demo 状态缓存到 state（安装/删除时失效），或与 loadWorks 并行。

[F-31] 低 · 异常流程（定时器未清理）· app.js:611、572、390-461
  问题：logsAutoTimer 只在再次进入日志页时清理（572）；切到其它视图时 renderView 不清理，定时器每 5 秒继续触发 refreshLogs，因 #log-list 不存在在 534-536 直接 return，是持续空转 interval。
  影响：常驻空转定时器（无网络请求，影响小）。
  建议：renderView 非 logs 分支统一清理 logsAutoTimer。

[F-32] 低 · 正确性Bug · app.js:5716-5723、358-359、5026、6332
  问题：删除词条后只更新 state.terms 与 loadWorkData(true)，state.termsCache 中该 id 未删；insertTermLink（5026）经 termsCache 取词条可插入已删词条的 stale 链接；tooltip（6332）同样显示已删词条。
  影响：悬空词条链接残留；提示内容与实际设定库不一致。
  建议：删除词条同步 termsCache.delete(id)；termsCache 随 loadWorkData 全量重建。

[F-33] 低 · 一致性 · app.js:5181-5198、2750-2751
  问题：保存作品时 collectModalData 直接提交，default_chapter_words、total_chapters 等数字字段以字符串上送（对比 save-api-config 5902-5903 有 Number 转换）。
  影响：依赖后端隐式转换；SQLite 存字符串后数值比较/排序异常。
  建议：与 save-api-config 一致对已知数字字段 Number 化（可复用 castNums 4848-4857）。

[F-34] 低 · 正确性Bug · app.js:782-785
  问题：stats.chapters/terms/characters/plotlines 直接插入 innerHTML 无兜底，后端字段缺失或改名时显示 "undefined"。
  影响：统计卡显示异常值。
  建议：`${stats.chapters ?? 0}` 兜底。

[F-35] 低 · 弃用代码（不可达分支）· app.js:434-443
  问题：goView（70-89）已把 SETTINGS_VIEWS 全部映射为 view='settings'、AI_VIEWS 映射为 'ai-board'，renderView 中 case 'plot'/'outline'/'terms'/'characters'/'memory' 与 'ai-create'/'ai'/'st' 分支不可达。
  影响：死代码，误导维护者。
  建议：删除或注释标明兼容旧会话数据的防御分支。

[F-36] 低 · 弃用代码 · app.js:5612、5614
  问题：document.execCommand 已被 MDN 标记弃用，formatBlock 等命令各浏览器行为不一致，未来可能移除。
  影响：格式按钮功能长期不可靠。
  建议：迁移到 Selection/Range + 手动包裹节点的现代实现。

[F-37] 低 · 弃用代码（死 CSS）· styles.css:71
  问题：.text-right 全项目无任何使用（grep 验证仅定义处出现）。
  影响：死 CSS。
  建议：删除。

[F-38] 低 · 弃用代码/错误声明 · styles.css:199-205 与 985-990
  问题：.search-group-title 定义两次，后者覆盖前者部分属性；987 行 `color: var(--muted)` 引用了 :root 中不存在的变量（只有 --text-dim），声明无效。
  影响：样式混乱源头、无效声明。
  建议：合并为一条规则，var(--muted) 改为 var(--text-dim)。

[F-39] 低 · 弃用代码（调试残留）· app.js:2382、2385、2504、2508、2511
  问题：5 处 console.warn 记录 AI 直连回退过程，属开发调试输出。
  影响：控制台噪音；已有统一 reportClientLog 通道。
  建议：收敛为 reportClientLog(level:'warn') 或移除。

[F-40] 低 · 正确性Bug · app.js:3763-3795
  问题：导入无文件大小限制；EPUB 走 bytesToBase64 全量读入内存（3763-3770）并以 JSON body POST（3785），几十 MB 文件内存与请求体压力大，无进度提示。
  影响：大文件导入可能失败或卡顿。
  建议：限制文件大小（如 50MB）；导入显示进度态；必要时改 FormData 上传。

[F-41] 低 · 一致性 · app.js:627-628
  问题：`works.filter((w) => w.id !== demoWorkId)`（628）严格比较，后端 demo.work_id 若返回字符串而 w.id 为数字，示例作品会同时出现在两处。
  影响：示例小说重复显示（取决于后端类型）。
  建议：Number(demoWorkId) 归一化后比较。

[F-42] 低 · 正确性Bug · app.js:2890
  问题：角色事件用 `String(e.summary).includes(character.name)` 粗匹配过滤，角色名出现在他人事件描述中被误列；短名（如「云」）误匹配更多。
  影响：状态事件列表混入无关事件。
  建议：服务端按 character_id 关联过滤，或词边界匹配。

[F-43] 低 · 异常流程 · app.js:2250-2308
  问题：AI 任务进度卡全局单例，activeAITask 槽位只保留最新任务的取消回调（2296-2298）。两个 harness 任务并发时后开进度卡覆盖前一个，旧任务停止通道丢失。
  影响：并发任务中旧任务无法停止。
  建议：任务队列/多卡栈，或前端全局互斥禁止并发 harness 任务。

[F-44] 低 · 异常流程 · app.js:187-199
  问题：toast 无数量上限、无去重；批量失败或轮询错误可瞬间堆叠几十条遮挡界面。
  影响：错误刷屏遮挡操作区。
  建议：限制同显条数（≤3），相同 message 短时间去重。

[F-45] 低 · 异常流程 · app.js:104-126
  问题：api() 无请求超时（无 AbortSignal.timeout），服务端无响应时 Promise 永不 settle，调用方 UI 可能永久停留等待态（harness 轮询除外）。
  影响：个别请求挂起导致交互卡死，需手动刷新。
  建议：api() 统一加超时（如 60s），超时抛可读错误。

==================================================
3.3 AI / 记忆 / 日志 / 数据库四模块（50 条）
==================================================

--- db.js（7 条）---

[DB-01] 中 · 一致性 · db.js:54-69、91-106 vs 306、309（及 server.js:159、162）
  问题：chapters.context_character_ids 与 characters.aliases 只存在于 ALTER 迁移（306、309），CREATE TABLE 正文未声明；server.js RESOURCE_CONFIG 把两列列入 fields 参与 INSERT/UPDATE。新库靠「先建表后 ALTER」才可用，schema 定义劈成两处。所有 ALTER 均 try/catch 全吞（291-309），某次失败（库锁/盘满）启动不报错，运行期第一次写才抛「no such column」。
  影响：schema 与代码耦合脆弱；静默迁移失败运行期才炸。
  建议：把两列并入对应 CREATE TABLE；ALTER 失败区分「列已存在」与其它错误，其余记 error/warn 日志。

[DB-02] 低 · 低效代码 · db.js:311-339 vs server.js:2672
  问题：chapters.parent_id 无索引，但通用 GET 支持 ?parent_id=N（2672），章节树取子章节时全表扫描；work_id/volume_id/plotline_id 有索引却漏 parent_id。
  影响：章节树展开类接口随章节数线性变慢。
  建议：`CREATE INDEX IF NOT EXISTS idx_chapters_parent ON chapters(parent_id)`。

[DB-03] 中 · 一致性/正确性Bug · db.js:29-30、38-40、49-51、67-68 等 vs server.js:105-107
  问题：schema 默认时间戳 `datetime('now')`（空格格式、无时区），server.js now() 写 `new Date().toISOString()`（ISO 格式）。两类格式写入同一批列：同一列内两种格式共存 → 字符串排序错乱（空格 0x20 < 'T' 0x54）；跨格式字符串比较失效（直接触发 OS-01 补索引漏判）。
  影响：ORDER BY 结果不可靠；依赖字符串比较时间戳的逻辑在旧数据上出错。
  建议：统一 ISO 8601（schema DEFAULT 改 strftime('%Y-%m-%dT%H:%M:%fZ','now') 或全部应用层写 ISO）；存量数据归一化迁移。

[DB-04] 低 · 异常流程 · db.js:13-16
  问题：未设置 PRAGMA busy_timeout。DatabaseSync 默认 busy timeout 0，锁冲突立即抛 SQLITE_BUSY；冒烟测试/双实例共享 NOVELSTUDIO_DATA_DIR（文件头注释明确支持）或 WAL checkpoint 竞争时直接抛错无重试。
  影响：多实例/测试场景偶发 SQLITE_BUSY 崩溃。
  建议：启动时 `PRAGMA busy_timeout = 5000`。

[DB-05] 低 · 安全 · db.js:159-169
  问题：api_configs.api_key 明文存入 SQLite，且 data/backup-* 存有整库备份（明文复制）；server.js GET /api/api_configs 将完整 key 原样回传前端。
  影响：密钥明文多处落盘，无掩码机制。
  建议：备份排除 api_configs 或加密存储；接口返回掩码（仅回显最后 4 位）。

[DB-06] 低 · 低效代码 · db.js:320 与 149-157
  问题：idx_plotline_characters_plotline 与 UNIQUE(plotline_id, character_id) 隐式索引最左前缀重复，冗余索引；每次写入多维护一个索引。
  影响：写放大（表数据量小，影响轻微）。
  建议：删除 idx_plotline_characters_plotline。

[DB-07] 低 · 弃用代码 · db.js:171-179 vs server.js:450-470
  问题：ai_error_logs 表仍在建表，但 server.js 已不再写入（改读 app_logs），仅作为 migrateAiErrorLogs 一次性迁移源保留，无 deprecated 注释。
  影响：新开发者可能误写进死表。
  建议：标注「仅迁移用，勿写」；迁移彻底后删表。

--- harness.js（12 条）---

[HA-01] 中 · 安全/正确性 · harness.js:32-33
  问题：源码硬编码本机绝对路径 'C:\Users\a1941\Desktop\DeepSeek\deepseek-harness' 与 'C:\Users\a1941\Desktop\deepseek-harness'（resolveHarnessDir 候选列表）。
  影响：用户名泄露进源码；换机/换用户后候选永远无效。
  建议：删除硬编码候选，仅保留环境变量与同级目录探测。

[HA-02] 高 · 异常流程 · harness.js:284-299 vs 183-195、306
  问题：超时分支只调用 child.kill()（287）终止直接子进程（node 跑 pnpm.js），pnpm 派生的 dsh 孙进程在 Windows 不会被级联杀掉；同文件 killChildTree（183-195，taskkill /T /F）已实现且取消路径（306）使用，唯独超时路径没用。超时后 dsh 任务实际仍在后台运行，插件继续 HTTP 回连工坊提交事件/记忆提案。
  影响：取消语义失效；孤儿进程消耗资源；产生用户不知情的后续写入。
  建议：超时分支改用 killChildTree(child)。

[HA-03] 中 · 异常流程/正确性 · harness.js:95-99、123-133、217-225
  问题：a) runPnpm 超时同样只 child.kill()（98），build 子进程可能残留；b) buildHarness 返回值被忽略（223-225），构建成功但产物标记缺失时静默继续 spawn，以难懂的插件加载错误告终；c) isHarnessBuilt 检查在 withModelSwitch 之外，两个并发请求可同时触发两次 pnpm build。
  影响：构建竞态；失败信息误导。
  建议：build 后再次检查 isHarnessBuilt() 失败即抛明确错误；build 加进程内互斥；build 超时同样杀进程树。

[HA-04] 中 · 异常流程/低效代码 · harness.js:210-215、235-381
  问题：withModelSwitch 把整段任务执行（含子进程全生命周期）串行化；即使 options.model 未传（无需改设置）也排队；单任务 10 分钟超时上限意味着后续任务整体等待；若某任务 promise 永不 settle（kill 失败后子进程不 close），互斥链永久阻塞，后续全部任务死锁。
  影响：并发生成吞吐受限（server.js createHarnessJob 的 jobs Map 给人可并行的印象，实际单线程排队）；潜在永久阻塞。
  建议：仅在「改设置→启动子进程」临界区互斥，子进程运行期不占锁；不带 model 的任务旁路互斥链。

[HA-05] 低 · 异常流程（错误吞没）· harness.js:236-247
  问题：readSettings 失败返回 null（135-141 吞异常），239 行 `options.model && originalSettings != null` 直接跳过补丁，无任何日志——用户指定模型却以默认模型运行，静默失败；writeSettings 抛错也仅被 246 行 catch 吞掉不记录。
  影响：模型切换失败对用户不可见，生成结果不符合预期难以排查。
  建议：两种失败至少各记一条 warn 日志（含 e.message）。

[HA-06] 高 · 安全 · harness.js:273-278
  问题：`spawn('pnpm', taskArgs, { shell: true, ... })` 回退路径——findPnpmJs 失败时启用 shell，Node 将参数拼成 cmd.exe 命令行且不做转义；prompt（任务描述文本，260 行 String(prompt).trim()）含 &、|、> 等元字符即构成命令注入。Node 文档明确禁止 shell:true 传未消毒输入。
  影响：本地命令注入（本地单用户实际危害有限，但属明确注入面）。
  建议：删除 shell:true 回退；pnpmJs 找不到时直接抛错提示安装 corepack/pnpm。

[HA-07] 中 · 正确性Bug · harness.js:148-167（尤其 161）
  问题：patchDefaultModel 把 model 字符串裸拼进 YAML 行（161 `line.replace(/:\s*.*$/, \`: ${model}\`)`）。model 来自 DB 或前端请求体，含换行/#/:/前导空格会破坏 settings.yaml 或注入新键。
  影响：用户配置文件被破坏；特殊字符模型名行为不可控。
  建议：model 做 YAML 安全校验/转义（仅允许 [A-Za-z0-9._-]），拒绝非法值。

[HA-08] 中 · 异常流程 · harness.js:235-381（尤其 243-244、369-380）
  问题：模型补丁在子进程整个运行期（最长 10 分钟）持续存在于全局 settings.yaml——期间外部 GUI dsh 会话读到被补丁的默认模型；若进程期间崩溃（logger.js uncaughtException 直接 process.exit(1)，310），finally 的 CAS 还原（369-380）不执行，settings.yaml 永久停留在补丁状态。
  影响：跨进程副作用；崩溃后用户默认模型被静默篡改。
  建议：启动时检测/清理残留补丁（原始内容记录到临时文件重启恢复）；或子进程启动后立刻还原设置。

[HA-09] 低 · 低效代码 · harness.js:280-281、319-330
  问题：stdout/stderr 字符串无上限累积（`stdout += chunk`），长任务输出持续驻留内存直至 promise 结束。
  影响：10-20 分钟 verbose 任务可累积数十 MB 内存。
  建议：环形缓冲（只留尾部 N KB），需完整输出时落临时文件。

[HA-10] 低 · 异常流程 · harness.js:284-299、302-317
  问题：超时分支未调用 cleanupSignal()（317 定义，仅 error/close 分支 335、347 调用），abort 监听器保留到 signal 被 GC；settled 标志使其无害，但清理不对称。
  影响：轻微监听器泄漏。
  建议：统一在 settled 置位处集中清理 timer + signal 监听。

[HA-11] 低 · 一致性（重复实现）· harness.js:169-180 vs server.js:427-434
  问题：readableError 与 server.js readableErrorMessage 功能重复（取首行非 at 文本、截断），两处独立演化。
  影响：维护漂移风险。
  建议：下沉到 logger.js 或共享工具模块。

[HA-12] 低 · 异常流程 · harness.js:143-145
  问题：writeSettings 用 writeFileSync 直接截断覆盖（无临时文件+rename），写盘中断可损坏用户 ~/.dsh/settings.yaml。
  影响：用户配置文件损坏风险。
  建议：写临时文件后 rename 原子替换。

--- openviking.js（7 条）---

[OV-01] 严重 · 异常流程（异步竞态）· openviking.js:253-263 vs 275-300
  问题：pending 队列丢失更新竞态。drainOpenVikingQueue：279 读文件快照 → await health（最长 4s）→ 逐条 await applyOp（每条最长 30s/120s）→ 292 writeQueue(remaining) 整文件覆盖。此期间 syncChange → safeWrite 失败 → enqueueOpenVikingOp（253-263）读-改-写同一文件。drain 最后的覆盖写会：a) 抹掉 drain 期间新入队的操作；b) 同 URI 合并场景更严重——drain 重放 URI X 的旧内容（成功），期间用户编辑产生 X 新内容入队并合并，drain 的 remaining 不含 X，覆盖写把最新内容永久清除。窗口长达数十秒，触发概率不低。
  影响：同步数据静默丢失，OpenViking 记忆索引停留旧版本，用户无感知。本模块最严重问题。
  建议：drain 结束写盘前重新 readQueue 合并（仅删本次已成功且未被重新入队的条目）；或 per-URI 版本号；或内存为主、文件为持久化镜像的单一权威状态。

[OV-02] 中 · 异常流程 · openviking.js:246-251、233-244
  问题：writeQueue 用 writeFileSync 截断覆盖（249），无临时文件+rename——崩溃/断电瞬间队列文件被截断；readQueue（239）对坏行 JSON.parse 失败静默置 null 过滤，即「半截文件 → 全部待重放操作无声丢失」。多进程并发写无锁互相覆盖。
  影响：离线期间积累的所有待同步数据可能一次性丢失。
  建议：写 tmp + rename 原子替换；坏行隔离到 .corrupt 文件并记 warn。

[OV-03] 中 · 低效代码 · openviking.js:253-263
  问题：每次入队都同步 readFileSync 全量读 + 全量 JSON 重写队列文件（236、249），去重 findIndex 线性扫描（257）。队列条目含整章正文（renderChapter 上限 20 万字符），服务器离线期间频繁编辑使文件快速膨胀，每次入队 O(n²) 且同步阻塞请求路径；无队列大小/条目上限。
  影响：离线编辑期间磁盘写放大、接口卡顿、队列无限增长。
  建议：内存维护队列状态 + 追加式日志（append 一行新操作 + 定期压缩），或限制条目数与单条大小。

[OV-04] 低 · 正确性Bug · openviking.js:102-134（尤其 113-124）
  问题：this.connected 语义不一致：HTTP 4xx/5xx（113-120 提前 return）不更新 connected，只有网络异常 catch 才置 false（124）。sync 层 getSemanticRecall（openviking-sync.js:480）据此区分 no-hits/unavailable——上次成功本次 500 时，find 空数组被误判为 no-hits 而非 unavailable。
  影响：状态展示/降级语义失真。
  建议：HTTP 错误也显式维护 connected（或独立 lastError/lastOk 时间戳）。

[OV-05] 低 · 弃用代码 · openviking.js:216-223
  问题：OpenVikingClient.list() 全仓无调用（grep 确认仅定义），死代码。
  影响：无（维护噪音）。
  建议：删除或标注供未来使用。

[OV-06] 低 · 异常流程 · openviking.js:288-290
  问题：操作连续失败 3 次后直接丢弃，仅一条 warn 日志（queue_dropped），无死信队列。health 抖动/5xx 期间离线积累的数据（含整章内容）永久丢失。
  影响：静默数据丢失（与 OS-07 联动放大）。
  建议：丢弃前写 data/openviking-dead.jsonl 死信文件，供人工检查/重放。

[OV-07] 低 · 正确性 · openviking.js:269-273
  问题：applyOp 对单写操作丢弃 op.mode（272 固定 replace）；syncWorkFull 入队的 meta 写带 'upsert' 语义（openviking-sync.js:339），重放按 replace 执行。效果近似但语义不对称，未来 server 端 replace/upsert 分化即成 bug。
  影响：潜在语义漂移。
  建议：applyOp 透传 op.mode。

--- openviking-sync.js（12 条）---

[OS-01] 中 · 正确性Bug · openviking-sync.js:400-402（配合 db.js:30、server.js:105-107）
  问题：autoIndexExistingWorks 用字符串比较判断过期：`String(indexedAt) < String(w.updated_at)`。ov_indexed_at 是 toISOString（375，含 'T'），works.updated_at 若仍是 schema 默认 datetime('now') 空格格式（DB-03）——同一 UTC 日期内空格(0x20) < 'T'(0x54)，使 indexedAt < updated_at 恒为 false：旧格式行当天修改后启动补索引永远漏判。
  影响：启动补索引对部分作品失效，记忆库停留旧状态。
  建议：比较前归一化为 Date.parse 或毫秒时间戳；根治依赖 DB-03 统一格式。

[OS-02] 中 · 异常流程（重放乱序/过期）· openviking-sync.js:369-374 与 openviking.js:285-292
  问题：入队的 batch 不与后续成功同步互斥。场景：离线 → syncWorkFull chunk 入队（旧内容快照）；短暂恢复 → 全量同步成功直写（新内容，未清队列）；再次离线 → 45s 定时器重放旧 batch，把新内容覆盖回旧版本。队列无「后续成功写入使旧条目失效」机制。
  影响：记忆库被过期内容回滚，无日志提示。
  建议：同 URI 成功直写后清除队列中对应旧条目；或队列条目携带内容哈希/生成序号，重放时与最新渲染比对。

[OS-03] 低 · 异常流程（退出清理）· openviking-sync.js:196-210
  问题：2s 防抖窗口内的变更只存在于 debounceMap 定时器，进程退出（logger.js 322-331 直接 process.exit，无 flush 钩子）时丢失：既未同步也未入 pending。
  影响：服务关闭前最后 2 秒内的编辑不反映到记忆库。
  建议：退出路径增加 flush（同步执行 debounceMap 全部任务并等待 safeWrite）再 exit。

[OS-04] 低 · 低效代码 · openviking-sync.js:485-499、525-537
  问题：getSemanticRecall / semanticSearchMerge 对命中逐条串行 await readContent（各带 5s 超时）——最坏 8×5s / 6×5s 串行等待，正常时也白白累加网络 RTT。
  影响：语义召回/搜索延迟偏大。
  建议：Promise.all 并行拉取（保留单条 5s 超时，整体可加总超时）。

[OS-05] 低 · 低效代码 · openviking-sync.js:413-414、462-463、510
  问题：recallCache 无上限且无定期清扫——只有同一 key 再次访问且超 TTL 才删除旧条目；长期运行、逐章写作时 Map 随 (workId,chapterId) 组合数持续增长。
  影响：长期进程内存缓慢增长。
  建议：LRU 上限（如 256）或周期性清扫。

[OS-06] 中 · 低效代码（N+1）· openviking-sync.js:144-145、153-159
  问题：renderTerm 每词条一次分类查询（145），renderCharacter 每角色一次关系查询（154-159）；collectWorkOperations（343-348）全量同步对全部词条/角色逐条执行，形成 N+1。
  影响：大设定库全量同步时 SQL 往返随条目数线性放大。
  建议：一次拉取全部 categories/relations 建内存 Map，渲染时查表。

[OS-07] 中 · 正确性Bug · openviking-sync.js:366-377
  问题：syncWorkFull 无论成功与否都写 ov_indexed_at（375）并返回 { ok:true, files, wrote }——部分失败甚至全部失败（仅入队）时调用方（server.js:2241、2689 等）与用户看到 ok。若队列后续被丢弃（OV-06 三振出局或 OV-02 文件损坏），索引标记仍显示「已最新」，启动补索引与手动重建索引端点都不会再同步该作品。
  影响：假成功掩盖同步失败，记忆库与 DB 永久不一致。
  建议：全部成功才写 ov_indexed_at；返回 wrote/files 供 server 反馈；队列丢弃时清空对应 ov_indexed_at。

[OS-08] 低 · 弃用代码（不可达分支）· openviking-sync.js:285-288
  问题：syncChange 的 'work_delete' 分支无人触发——server.js 删除作品走 removeWorkFromMemory（2717），全仓无 notifyChange('work_delete') 调用。
  影响：死分支误导维护者。
  建议：删除该分支或由 removeWorkFromMemory 内部复用。

[OS-09] 低 · 弃用代码（无效通知路径）· openviking-sync.js:289-291 vs server.js:2664-2666、2692
  问题：通用 CRUD 对 plotline_characters 增删改均触发 notifyChange，但 syncChange 无对应 case 落入 default 空分支——防抖 2 秒后空跑一次（外加一次 semanticEnabled DB 查询），纯浪费且造成「已同步」错觉。
  影响：无效工作 + 语义误导（plotline_characters 的 status/notes 实际不进记忆库）。
  建议：补渲染逻辑，或在 server 侧过滤该资源不通知，并加注释说明。

[OS-10] 低 · 安全（注入模式）· openviking-sync.js:212-215
  问题：lookupRow 动态拼接表名 `SELECT * FROM ${table} WHERE id = ?`。当前 table 仅来自内部 switch 常量（安全），但函数签名开放，未来调用方传入外部字符串即构成 SQL 注入。
  影响：当前无实际漏洞，属隐患模式。
  建议：加白名单断言（Set 校验 table 名）。

[OS-11] 低 · 一致性（重复实现）· openviking-sync.js:75-90 vs server.js:507-516
  问题：htmlToPlain 与 server.js plainText 重复实现（注释自认「同源实现」），正则细节（实体解码顺序、空白折叠）已出现漂移点。
  影响：两处行为逐步分化，导出/检索文本不一致。
  建议：提取到无依赖共享模块（如 text-utils.js）。

[OS-12] 低 · 低效代码 · openviking-sync.js:402-403
  问题：autoIndexExistingWorks 循环内 syncWorkFull(w.id).catch(...) 不 await，仅 sleep 1.5s——间隔只保证「启动时间」错峰；单个全量同步超过 1.5s 即与下一个并发重叠，注释声称的「错峰避免 embedding 挤占 CPU」意图部分失效。
  影响：启动期 OpenViking 服务器 CPU 尖峰。
  建议：改为 await 每个同步完成（失败 catch 后继续），或引入小并发池（如 2）。

--- logger.js（12 条）---

[LG-01] 中 · 低效代码 · logger.js:118-123
  问题：writeFileLog 每条日志同步 fs.mkdirSync + appendFileSync（120-121）——http_error/ai_error/slow_request/harness 事件全部同步阻塞磁盘写；本模块还自带事件循环滞后监测（260-295），日志自身正是卡顿来源之一。
  影响：高频日志时主线程阻塞、请求延迟抖动。
  建议：内存缓冲 + 异步批量 flush（定时/达阈值），保留崩溃兜底（exit 前同步 flush）。

[LG-02] 中 · 低效代码 · logger.js:125-137
  问题：writeDbLog 每条日志同步 SQLite INSERT（131-135），请求路径上的错误/慢请求日志同步落库，与业务 SQL 竞争同一把写锁。
  影响：日志量大时拖慢业务请求；与 LG-01 叠加双重同步 I/O。
  建议：同 LG-01 的批量缓冲（事务内多条 INSERT）。

[LG-03] 中 · 低效代码 · logger.js:87-98、195
  问题：captureCaller 对每条非 remote、非 error 的日志都 new Error().stack 并逐帧正则解析（88-97），debug/info 级别也全量执行。
  影响：高频 info/debug 日志的 CPU 开销。
  建议：仅 warn/slow/error 级别解析调用栈；或抽样/缓存（同调用点复用）。

[LG-04] 低 · 弃用代码（死标志）· logger.js:58 vs 126、337、373、414、423、454
  问题：dbInitFailed 声明（58）后在 5 处判读，但全文件从未赋值为 true（grep 确认无赋值点）。initLogger 的 catch（454 注释「初始化失败降级为仅文件日志」）并未置位——降级路径形同虚设，prepare 每次仍尝试并吞错。
  影响：设计意图（一次性降级）未实现；误导维护者。
  建议：initLogger 的 migrate/prune 抛错时置 dbInitFailed = true；或删除该标志。

[LG-05] 低 · 正确性/一致性 · logger.js:421-443 vs 334-361、db.js:171-179
  问题：a) migrateAiErrorLogs 把 ai_error_logs.created_at（schema 默认空格格式）原样写入 app_logs.ts（440），与新日志 ISO 格式混排——同日 ORDER BY ts 排序错乱，可能漏掉真正最新记录；b) 30 天保留策略（346）会删掉已迁移行，下次启动迁移因 dedup_key 不存在而重复插入、再被 prune 删掉——每次启动无谓写库循环。
  影响：日志排序局部失真；启动期重复迁移开销。
  建议：迁移时归一化 ISO；迁移完成打「已迁移」标记（app_settings）不再重复执行。

[LG-06] 中 · 异常流程（退出清理）· logger.js:297-332
  问题：退出处理不完整：a) SIGINT/SIGTERM 直接 log + setTimeout(exit(0),100)（322-331）——不 db.close()、不 flush 防抖同步（OS-03）、不终止 harness 子进程（孤儿 dsh 继续运行）；b) 覆盖 Node 默认「第二次 Ctrl+C 强杀」语义，I/O 卡死时无法强退；c) unhandledRejection 仅记日志不退出（313-320），改变 Node 默认崩溃语义，可能让服务带不一致状态继续运行掩盖 bug；d) uncaughtException 处理中 log 本身要同步写盘，若崩溃源于日志/DB 层，200ms 延迟（310）未必足够，日志可能丢失。
  影响：退出不干净（孤儿进程、未落盘数据）；故障被掩盖。
  建议：退出路径改为有序 shutdown（停止接收、终止 harness 子进程、flush 日志与同步队列、db.close()）；重复信号提供强杀通道；明确 unhandledRejection 策略。

[LG-07] 低 · 正确性（边界）· logger.js:139-145
  问题：consoleEcho 中 codeLine 为 null（远端上报未给行号）时输出 `${where.file}:${where.line}` 呈 "file:null"。
  影响：控制台文案瑕疵。
  建议：line 为空时只输出文件名。

[LG-08] 低 · 正确性 · logger.js:372-395
  问题：queryLogs 带 beforeId 翻页时，stats 统计 SQL 复用同一 whereSql（390-392）——翻到第 2 页后 total 与 by_level 只统计剩余窗口，UI 的「总数/分级统计」越翻越小。
  影响：日志面板统计失真。
  建议：stats 查询去除 beforeId 条件（单独计算全量统计）。

[LG-09] 低 · 异常流程 · logger.js:449-458
  问题：initLogger 无幂等防护，重复调用会重复注册 6 小时 prune 定时器（455）、重复迁移（452）、重复装 lag 监测（后者有 lagMonitorStarted 防护，268）。冒烟测试/热重载场景可能多次调用。
  影响：重复定时器/重复迁移（unref 不阻塞退出，但语义脏）。
  建议：加 initialized 标志；或保证启动只调用一次（server.js:2767 现状单次，属防御性建议）。

[LG-10] 低 · 安全 · logger.js:160-217、185-189 vs server.js:2548-2568、63
  问题：remote 上报的 context 无深度/大小限制——仅受 readBody 32MB 上限约束，恶意/失控前端可提交超大 context，JSON.stringify 同步阻塞 + 文件/DB 放大；code_file/code_func/stack 原样入库。同源校验 + 前端 esc 已缓解 XSS，但落盘放大与阻塞仍存在。
  影响：本地恶意页面的 DoS 放大面。
  建议：remote 的 context/stack 加体积上限（如 64KB），超出截断。

[LG-11] 低 · 正确性（错误吞没）· logger.js:213-216
  问题：log() 顶层 try/catch 全吞（216）——若 context 含循环引用，writeFileLog 的 JSON.stringify(record)（121）与 writeDbLog 的 JSON.stringify(record.context)（134）抛错均被吞，该条日志文件与 DB 双双静默丢失，无任何告警。
  影响：特定场景日志静默丢失（error 级丢失最痛）。
  建议：序列化失败降级为安全字符串化（去循环、限深），保证 error 级至少写文件。

[LG-12] 低 · 低效代码 · logger.js:173-178
  问题：dedupMap 仅在 size>4000 时全量遍历清理——持续超 4000 个活跃 key 时每条日志都要 O(n) 遍历一次（清理阈值内新 key 不会被删，紧贴上限时反复全量扫描）。
  影响：极端刷屏场景的额外 CPU。
  建议：定期清扫（每 60s）或插入时惰性采样清理。

==================================================
3.4 harness-plugins/novel-writing/（23 条）
==================================================

[P-01] 中 · 一致性 · plugin.json:31-53
  问题：engineEndpoints 缺插件实际调用的 /api/works（novel-tools.mjs:157、179）、/api/search（:204）、/api/logs（:105），与 README「唯一真源」宣称及 ENGINE.md:180（列出了 /search）互不一致；smoke 还测了未列出的 /api/novel/semantic 等。
  影响：清单失去「真源」地位，文档读者被误导。
  建议：补全清单并在 smoke 加清单完整性断言。

[P-02] 低 · 一致性 · ENGINE.md:58 §3f vs plugin.json:3、novel-tools.mjs:31、install.ps1:25、GUIDE:13、README:115
  问题：ENGINE.md 标 v0.9.0 而其余全部为 0.8.0，且 smoke.mjs:621-645 已断言该端点存在。版本未同步升级。
  影响：文档版本漂移。
  建议：统一版本号。

[P-03] 低 · 弃用代码 · novel-tools.mjs:94
  问题：options.noRetry 死参数，全文件无调用方（grep 仅命中定义行），method 判断已覆盖「写不重试」。
  影响：死参数。
  建议：删除。

[P-04] 中 · 异常流程 · novel-tools.mjs:60-67、92-97
  问题：将 AbortSignal.timeout 超时与连接失败混为一谈，超时报错文案误导为「请确认服务已启动(npm start)」；且 GET 超时也被当作连接失败重试一次，最坏延迟 25s+25s 翻倍。
  影响：误导性错误 + 超时任务翻倍等待。
  建议：按 e.name==='TimeoutError' 区分并排除重试。

[P-05] 低 · 正确性Bug · novel-tools.mjs:159
  问题：空列表提示硬编码 http://127.0.0.1:3737，忽略 NOVELSTUDIO_BASE_URL/config.baseUrl（对比 :63 用了 ${base}）。
  影响：非默认端口时提示地址错误。
  建议：使用 ${base}。

[P-06] 低 · 正确性Bug · novel-tools.mjs:187、317、348
  问题：响应字段无防御访问：:187 ctx.work.title/ctx.chapter.position、:317 e.summary.slice、:348 data.total（缺字段时输出「命中 undefined 处」），缺字段时抛不可读 TypeError。
  影响：工具返回不可读错误。
  建议：加 ?. 与默认值。

[P-07] 低 · 正确性Bug · novel-tools.mjs:391、394
  问题：novel_event_add 的 kind（391）、foreshadow_status（394）无客户端白名单校验（同文件 :265 的 status 有校验，标准不统一；smoke 未测事件 kind）。
  影响：非法值直达服务端。
  建议：与 :265 对齐加白名单。

[P-08] 低 · 一致性 · plugin.json:20
  问题：称 novel_foreshadows「支持按 id 回收」，实现（:233-250）只查询，回收由 novel_event_add 的 resolves_event_id 完成（:255、368-369）。描述与实现不符。
  影响：误导 dsh 会话行为。
  建议：修正描述。

[P-09] 中 · 异常流程 · install.ps1:144-176、113-137
  问题：无回滚：ErrorActionPreference='Stop'（:18）下两步安装/多步卸载任一步失败即半安装（preset 新 headless 旧或反之），备份存在但无自动还原。
  影响：半安装状态难排查。
  建议：失败时自动还原备份。

[P-10] 中 · 异常流程 · install.ps1:47-50、171、127
  问题：WriteAllText 直写 cordis.patch.yml 与卸载写回，非原子写，中断可损坏 headless profile。
  影响：用户 profile 文件损坏风险。
  建议：临时文件 + Move-Item 原子替换。

[P-11] 中 · 一致性 · install.ps1:7 vs 39-44
  问题：注释宣称「重复安装不会堆积 .bak 文件」，但 Backup-File（39-44）每次装/卸都新建时间戳 .bak，全脚本无清理逻辑。注释与实现矛盾。
  影响：.bak 持续堆积（且 P-22 同秒覆盖失真）。
  建议：保留最近 N 个 .bak 自动清理，或修正注释。

[P-12] 中 · 正确性Bug · install.ps1:66-76
  问题：旧版区块启发式「标记行→全文件最后一个 baseUrl 行」：用户自加条目含 baseUrl 时被一并删除；截断的新块（有起始标记无结束标记）也会落入该路径（块首 :32 含 legacyMarker 文本），吞用户条目。
  影响：升级时可能删除用户自定义条目。
  建议：收紧为标记行后第一个 baseUrl 行并加警告。

[P-13] 低 · 正确性Bug · install.ps1:140-142
  问题：预检漏检 preset.yml（:29），缺失时在 agent.cordis.yml 已复制（:152）后才于 :153 失败，半安装。
  影响：半安装状态。
  建议：预检纳入 preset.yml。

[P-14] 低 · 一致性 · install.ps1:25 vs plugin.json:3、novel-tools.mjs:31
  问题：版本号三处手动同步（plugin.json/PLUGIN_VERSION/install.ps1:25），GUIDE:55 契约只要求前两处，install.ps1 未纳入。
  影响：版本漂移风险。
  建议：install.ps1 运行时读 plugin.json。

[P-15] 中 · 异常流程 · smoke.mjs:105-114
  问题：spawn 无 'error' 事件处理（server.js 缺失时未捕获崩溃，spawn 在 try:127 之外）、无过早退出检测，只能等 18s 超时（:117-124）看日志尾部。
  影响：失败诊断慢且不直观。
  建议：监听 'error'/'exit'，提前退出即报告 stderr。

[P-16] 低 · 异常流程 · smoke.mjs:86、717-723
  问题：外部模式（server===null）下 dataDir 创建后永不清理（finally 仅在 server 存在时删）。
  影响：临时目录泄漏。
  建议：外部模式也清理。

[P-17] 低 · 低效代码 · smoke.mjs:93-103
  问题：测试 jfetch 无超时（对比 novel-tools.mjs:60），服务假死时无限挂起。
  影响：CI 场景挂死无上限。
  建议：加超时。

[P-18] 低 · 正确性Bug · smoke.mjs:612-613
  问题：硬编码 8s 性能断言易抖动；缓存耗时只打印不断言（半成品断言）。
  影响：测试间歇性失败；性能回归无守卫。
  建议：改为相对阈值并断言缓存命中。

[P-19] 低 · 低效代码 · smoke.mjs:81
  问题：随机端口（3900-4299）无占用预检，冲突只能 18s 超时后看日志。
  影响：偶发测试失败难排查。
  建议：预检端口占用并重选。

[P-20] 中 · 一致性 · novel-tools.mjs:266-269
  问题：novel_foreshadow_update 在提案模式下直写伏笔状态不带 proposed，对照 novel_event_add:397/memory_update:428 均带 proposeMode()；与 ENGINE.md:30-39「headless 防污染」及 GUIDE:44-45「写账本类工具必须遵循提案模式」的契约存在缝隙。
  影响：headless 会话可绕过提案直接改伏笔状态。
  建议：纳入提案流或在文档/人设中声明 GUI 专用。

[P-21] 低 · 一致性 · README.md:20
  问题：称 smoke.mjs 为「node:test」，实际（:13-19）未 import node:test，是自研脚本。
  影响：文档不实。
  建议：修正描述。

[P-22] 低 · 正确性Bug · install.ps1:41-42
  问题：备份名秒级时间戳（yyyyMMddHHmmss），同秒两次安装覆盖同一 .bak，备份失真。
  影响：备份不可靠。
  建议：时间戳加毫秒或随机后缀。

[P-23] 低 · 正确性Bug · novel-tools.mjs:46、56
  问题：baseUrl 尾斜杠未归一化，产生 //api/... 双斜杠 URL，部分路由/代理下 404。
  影响：配置带尾斜杠时请求失败。
  建议：baseOf 归一化去尾斜杠。

==================================================
3.5 基础设施与跨模块（主审独立核实，8 条）
==================================================

[Z-01] 低 · 健壮性 · zip-reader.mjs:36-37
  问题：`buf.subarray(dataStart, dataStart + compSize)` 越界时静默截断而非报错——损坏 ZIP 的 compSize 超实际大小时解出半截数据，无任何提示（对比 :21、:31 对头部有边界检查，数据区无）。
  影响：损坏 EPUB 静默产出乱码章节，用户难定位。
  建议：校验 dataStart + compSize <= buf.length，否则抛「ZIP 数据区损坏」。

[Z-02] 低 · 低效代码 · zip-reader.mjs:41、46
  问题：inflateRawSync 同步解压 + 全部条目一次性进内存。EPUB 数 MB 可接受；大文件会阻塞事件循环（导入发生在请求路径上）。
  影响：大 EPUB 导入期间服务整体卡顿。
  建议：限制导入大小（前端已有 24MB 服务端校验），或改异步解压。

[Z-03] 低 · 异常流程 · start-novel-studio.cmd:14-24
  问题：用 curl 探测 /api/works 判定「已在运行」，但服务器启动中未就绪时探测失败会再 start 一个实例 → 端口冲突第二实例退出；固定 timeout /t 2 等待，慢启动时浏览器打开失败页；无 Node 版本检查（package.json engines >=22.5 未在此脚本校验）。
  影响：偶发双实例/空页面。
  建议：增加重试探测；检查 Node 版本。

[Z-04] 低 · 一致性 · novel-studio-icon.ps1
  问题：该文件为 GBK/ANSI 编码（注释中文被 UTF-8 读出为乱码「灏忚 宸ュ潑」），与仓库其余全部 UTF-8 文件不一致。PowerShell 7 默认按 UTF-8 读无 BOM 文件会误读；Windows PowerShell 5.1 按 ANSI 读则正常。
  影响：跨环境/编辑器兼容性隐患；混编码仓库易出乱码提交。
  建议：转为 UTF-8（无 BOM）重存。

[Z-05] 低 · 一致性 · package.json:3 vs README.md:94
  问题：package.json version 0.1.0，README 版本 v0.9.1，插件 0.8.0，三处版本语义不一致；scripts 中 dev 与 start 完全相同（无真正 dev 脚本）。
  影响：版本溯源混乱。
  建议：统一版本号策略；dev 脚本补实际用途或删除。

[Z-06] 中 · 异常流程 · server.js:2271-2292、984-1018（运行时日志实锤）
  问题：POST /api/novel/events 对非法 work_id（不存在的作品）直接触发 FK 违约抛 500 原始错误「FOREIGN KEY constraint failed」。证据：data/logs/app-2026-09-06.log 第 3 条记录（05:59:05 真实运行时错误）；更糟的是冒烟测试 test/smoke.mjs:696-697 主动构造该场景并断言 500，把这一坏行为固化为契约。同时 chapter_id 不校验与 work_id 的归属（串作品），dedup_key 查重与插入分离（见 S-14）。
  影响：客户端传参错误被报告为服务器故障；错误信息泄露内部结构；坏行为被测试固化后更难修。
  建议：写事件前校验 work_id 存在（404）与 chapter_id 归属（400）；smoke 断言改为 400/404。

[Z-07] 低 · 一致性 · logger.js:413-419 vs 前端「一键清空」
  问题：DELETE /api/logs（clearLogs）只清 SQLite 表，不清滚动文件 data/logs/*.log；面板按钮 title「清空数据库中的全部日志记录」文案已如实标注，但「清空」与用户直觉（全清）存在落差，且文件保留策略（14 天）与 DB 保留（30 天）不对称。
  影响：用户以为清空后文件仍存历史（隐私直觉落差）。
  建议：清空时同步截断当天文件，或界面明确提示「仅清数据库，文件日志保留 14 天」。

[Z-08] 低 · 数据卫生 · data/logs/app-2026-09-06.log
  问题：运行时日志混入开发测试数据：第 2 条「????:???? / Error: manual」（工具上报管道测试占位消息）、第 3 条 FK 错误（smoke 注入 work_id=999999999）、第 4 条「中文往返验证：页面运行时错误」（前端上报管道人工验证）。冒烟测试在 SMOKE_TARGET_BASE 外部模式下会直接污染真实服务器的 app_logs 与日志文件。
  影响：生产日志与测试数据混杂，干扰故障排查。
  建议：外部模式冒烟测试前备份/标记测试条目，测试后清理；或禁止外部模式写入真实数据目录。

----------------------------------------------------------------------
四、C. 亮点（值得保留的良好实践）
----------------------------------------------------------------------

1. 安全底线扎实：全部 SQL 参数化；动态表名仅经固定 Set 白名单（crudResources/RESOURCE_CONFIG）；静态服务路径穿越防护（normalize + publicDir 前缀校验）；写请求 Origin 校验（纵深防御，对无 Origin 的 CLI 客户端友好放行）；CORS 收紧（不再返回 ACAO:*）。
2. 事务纪律：多写操作普遍 BEGIN/COMMIT/ROLLBACK（saveStoryMemory/replaceRedlines/installDemo/settleProposals/版本恢复等）；FK 级联删除链完整。
3. 缓存体系：预编译语句缓存；上下文装配缓存（版本号整体失效 + LRU 上限 64）；语义召回 30s 微缓存；分层预算 + 按层标签定位收缩 + 红线/角色卡保底，避免整层盲截。
4. 外部依赖全面「失败静默降级」：OpenViking 不可用不阻塞写作；AI 直连失败自动回退 harness；思考型模型空回复重试；超时按任务类型分级（写章 10 分钟/短任务 3 分钟）。
5. 日志系统设计：双写（SQLite+滚动 JSONL）崩溃可查；调用栈自动解析 file:line:func；防刷屏去重；主动事件循环滞后/慢请求/慢操作监测；远端上报 layer 白名单防伪造；全部定时器 unref 不阻退出。
6. 前端工程质量：api() 统一封装（res.ok 检查、JSON 容错、慢 API 上报）；esc() 在绝大多数动态渲染点正确使用；事件委托（单一 document click 分发约 120 个 action）避免重建 DOM 的监听器泄漏；搜索/日志/保存均防抖；localStorage/sessionStorage 全部 try/catch 容错；会话恢复白名单校验。
7. 插件工程质量：jfetch 严格客户端（三类失败可读错误 + nsReported 防重复上报 + GET 失败仅重试一次、写不重试防重复入账）；URL 全量 encodeURIComponent；无共享可变状态（并发安全）；install.ps1 区块合并保留用户条目、兼容旧版、-DryRun/-Uninstall、无 BOM UTF-8 写入、空格/中文路径处理正确；区块标记字节级一致；plugin.json 13 工具与代码注册 13 工具一一对应。
8. 测试体系：smoke.mjs 23 组断言覆盖核心链路（安全/归属/幂等/回滚/性能/缓存失效/日志），临时数据目录+随机端口+finally 清理+exitCode 正确，支持外部服务复用与 NOVELSTUDIO_REPO 定位。
9. 产品细节：提案制入账（AI 事件/记忆先提案作者确认，防 AI 污染账本）；历史版本与记忆版本剪枝；导出/审稿/蓝图等核心流程均带确认与备份；LCS diff 超大输入降级防内存爆炸；批量生成失败即停且已完成章节保留。
10. 文档坦诚记录已知边界（ENGINE.md:201-209），无过度承诺。

----------------------------------------------------------------------
五、修复优先级建议
----------------------------------------------------------------------

P0（立即，数据丢失类）：
  1. F-01 自动保存竞态（切章/切页前 flushSave，或保存闭包捕获快照）
  2. F-02 loadWorkData 过期结果校验（写回前 state.workId 比对）
  3. OV-01 队列 drain 合并写（写盘前重读队列合并）
  4. HA-02 超时路径 killChildTree

P1（尽快，安全与正确性）：
  5. HA-06 移除 spawn shell:true 回退
  6. F-03/F-04/F-05 XSS 三处（渲染前白名单消毒 + AI 输出转义）
  7. F-06 词条搜索框重建修复（功能不可用）
  8. F-08 保存乐观锁（携带 updated_at）
  9. S-17 导出段落结构（改用 htmlToPlain）
  10. S-13 大纲省略数学错误（token 预算）
  11. S-02 readBody 字节累计（内存上限 + 中文损坏）
  12. DB-03 时间戳格式统一（联动 OS-01 补索引漏判）

P2（常规清理，低风险高收益）：
  13. S-12 缓存失效缺口（restore/全局红线 touchWork）
  14. S-26 跨作品归属校验；Z-06 事件端点输入校验（并修正 smoke 断言）
  15. HA-04 互斥链收窄（并发吞吐）；HA-08 模型补丁崩溃残留
  16. OS-07 syncWorkFull 假成功（成功才写 ov_indexed_at）
  17. LG-01/02/03 日志 I/O 缓冲化（自伤卡顿源头）
  18. 死代码批次清理：F-17..F-26、F-35、S-32、P-03、OV-05、OS-08、LG-04、DB-07
  19. 重复实现收敛：S-19（两套上下文装配）、F-23/24/25（diff/提问/插入）、HA-11、OS-11
  20. 文档一致性：P-01（端点清单补全）、P-02/P-14（版本号）、P-08（工具描述）、Z-05（package 版本）

附注：
- 本报告所有行号以审查时工作副本为准（server.js 2805 行、app.js 6415 行、styles.css 1163 行、db.js 339 行、harness.js 392 行、openviking.js 303 行、openviking-sync.js 542 行、logger.js 464 行、novel-tools.mjs 534 行、smoke.mjs 724 行、install.ps1 183 行）。
- 标「需运行时验证」的条目（S-07、S-22、S-35）建议在修复验证阶段用大数据量/并发脚本复现确认。
- 未改动任何代码；修复建议仅为方向性参考。
