# Novel Studio 代码审查修复说明（2026-09-06）

依据 `docs/code-review-report.md` 的全部 161 项发现实施修复。除明确标注「经复核不成立/无需改动」的项外，其余均已落实。全程保持零依赖架构与现有 API 契约。

## 修复总览（按模块）

### server.js（S-01 ~ S-35 全部落实）
- 请求体读取：按字节累计（S-01/S-02）——32MB 上限按字节生效、跨分块多字节 UTF-8 不再乱码；错误附加 code，顶层统一映射 413/400；写响应前校验 socket 未销毁。
- 跨源防护：无 Origin 的写请求校验 Host 主机名（S-06）。
- 通用 CRUD：updateRow/deleteRow 返回影响行数，PUT/DELETE 不存在返回 404（S-03）；畸形 id 段返回 404（S-04）；api_configs 返回掩码密钥（S-05）；新增 validateOwnership 跨作品引用一致性校验（S-26）；plotline_characters 变更触发 touchWork 失效缓存（OS-09 联动）；chapters PUT 支持 `_if_updated_at` 乐观锁（配合 F-08）。
- AI 层：chatCompletionsUrl 归一化 + callAI 回退修正（S-15）；generateNovel 仅对可重试错误重试（S-29）；getConfigFromBody 校验 config_id（S-35）。
- 红线：seed 改用 app_settings 标志，不再在用户清空后复活（S-11）；病态正则嵌套量词拦截（S-23）；扫描文本 1M 字符上限。
- 事件账本：查重移入事务 + (work_id,dedup_key) 唯一索引兜底（S-14）；resolves_event_id 校验目标为同作品伏笔（S-26）；写事件前校验作品存在/章节归属，非法输入 404/400 而非 500（Z-06）；created_at 显式写 ISO。
- 大纲省略数学修正为「前 30 + 最近 40」（S-13）。
- 导出：改用保留段落边界的 htmlToPlain（S-17）；导入 base64 合法性校验（S-30）。
- EPUB：命名空间/属性顺序兼容 + 实体解码（S-16）。
- 上下文装配：buildAIContext 与 buildNovelContext 共用 pickWorldEntries（S-19）；防串作品校验（S-26）；/api/ai_context 复用已加载章节行（S-20）；缓存失效缺口补齐（restore/全局红线 touchWork，S-12）。
- Harness 任务：淘汰只删终态、否则先 abort（S-08）；并发上限 2（S-09）；超时钳制 1s~60min（S-10）；/harness/stop 返回 501（S-32）。
- 示例导入：记忆/事件纳入同一事务（S-33）；状态码语义修正（S-31）。
- 其它：stmtCache 上限 500（S-25）；touchWork 失败记 warn（S-34）；serveStatic 流错误兜底（S-07）；日志 context 8KB 上限（S-24）；记忆回滚补 version_id（S-27）；空提案不覆盖记忆（S-28）；demoToHtml 删除改 textToHtml（S-18）；压缩记忆只取正文头部（S-21）；搜索内容 LIKE 限头部（S-22）。

### db.js（DB-01 ~ DB-07）
- context_character_ids/aliases 并入 CREATE TABLE；迁移失败区分「列已存在」并告警（DB-01）。
- 补 idx_chapters_parent（DB-02）。
- 时间戳统一 ISO：CREATE 默认改 strftime + 存量空格格式一次性归一化迁移（DB-03）。
- PRAGMA busy_timeout=5000（DB-04）；api_configs 加备份敏感注释（DB-05）；删除冗余 plotline 索引（DB-06）；ai_error_logs 标注废弃（DB-07）。

### harness.js（HA-01 ~ HA-12）
- 删除硬编码本机绝对路径（HA-01）；超时路径改 killChildTree（HA-02）；build 互斥 + 产物复查（HA-03）；模型切换互斥收窄为仅模型任务串行、无模型任务并行（HA-04）；readSettings/writeSettings 失败记 warn（HA-05）；删除 shell:true 注入回退（HA-06）；模型名合法性校验（HA-07）；模型补丁侧车备份 + 启动崩溃残留还原（HA-08）；stdout/stderr 环形缓冲 64KB（HA-09）；超时分支补 cleanupSignal（HA-10）；readableErrorMessage 下沉到 logger（HA-11）；writeSettings 原子写（HA-12）。

### openviking.js（OV-01 ~ OV-07）
- 队列改「内存权威 + 文件镜像」，drain 结束以内存最新写盘，消除丢失更新竞态（OV-01）；写盘原子替换 + 坏行隔离 .corrupt（OV-02）；入队基于内存 + 队列上限 1000（OV-03）；HTTP 错误也标记 connected（OV-04）；删除死方法 list（OV-05）；死信文件（OV-06）；applyOp 透传 mode（OV-07）。

### openviking-sync.js（OS-01 ~ OS-12）
- 时间戳归一化比较（OS-01）；直写/全量成功后清队列旧条目（OS-02）；退出前冲刷防抖（flushDebouncedSync，OS-03）；召回内容并行拉取（OS-04）；recallCache LRU 上限（OS-05）；全量同步预载分类/关系消除 N+1（OS-06）；全量成功才写 ov_indexed_at（OS-07）；删除不可达 work_delete 分支（OS-08）；lookupRow 表名白名单（OS-10）；htmlToPlain 下沉 text-utils.js（OS-11）；启动索引 await 串行（OS-12）。

### logger.js（LG-01 ~ LG-12）
- info/warn/slow/debug 批量缓冲异步落盘，error 同步直写（LG-01/02）；调用栈仅 warn/slow/error 解析（LG-03）；dbInitFailed 实际置位（LG-04）；AI 错误迁移时间戳归一化 + 一次性标记（LG-05）；有序退出（flush 同步 + onExit + 二次信号强杀 + unhandledRejection 策略注释，LG-06）；consoleEcho 空行号修正（LG-07）；查询统计排除翻页条件（LG-08）；initLogger 幂等（LG-09）；safeStringify 防循环 + 长度上限（LG-10/11）；dedupMap 定期清理（LG-12）。新增 readableErrorMessage 供 server/harness 共用。

### 前端 public/（F-01 ~ F-45，由子代理完成）
- XSS：新增 sanitizeEditorHtml（DOMParser 白名单）覆盖渲染/保存/版本预览；AI 草稿统一 textToParagraphsHtml 转义（F-03/04/05）。
- 竞态：自动保存闭包快照 + flushSave 落盘（F-01）；loadWorkData 过期结果丢弃（F-02）；搜索序号（F-09）；harness 轮询总超时+退避（F-10）；进度卡互斥（F-43）。
- 乐观锁：PUT 带 _if_updated_at + 409 处理（F-08）。
- 修复词条搜索框重建丢焦点（F-06）；大纲渲染 O(N²) 预建索引（F-12/27）；分类/角色/字数/demo 缓存（F-28/29/30）。
- 弃用清理：死函数/死变量/死 CSS/调试残留/重复函数合并/execCommand 迁移（F-17~26、F-35~39）。
- 其它：api() 60s 超时 + 非 JSON 可读错误 + status（F-15/45）；导入 50MB 上限（F-40）；统计兜底（F-34）；toast 上限（F-44）；语义相关度换算（F-11）；侧栏折叠动画（F-13）；日志定时器清理（F-31）；termsCache 同步（F-32）；作品数字字段 Number 化（F-33）；demoWorkId 归一化（F-41）；角色事件过滤（F-42）。

### 插件 harness-plugins/（P-01 ~ P-23，由子代理完成；smoke.mjs 由主会话完成）
- novel-tools.mjs：删死参数、区分超时与连接失败、baseOf 尾斜杠归一化、字段防御访问、kind/foreshadow_status 白名单、提案模式伏笔不直写、baseUrl 用于提示（P-03~07、20、23）。
- plugin.json：补端点清单、修正工具描述（P-01、08）。
- install.ps1：安装/卸载回滚、原子写、.bak 保留 5 个、旧版区块启发式收紧、预检 preset.yml、版本随 plugin.json、毫秒时间戳、UTF-8 BOM（P-09~14、22）。
- 文档：版本统一 0.8.0、smoke 描述修正（P-02、21）。
- smoke.mjs：spawn error 处理、外部模式清理、jfetch 超时、性能断言放宽并断言缓存更快、端口范围加宽、非法 work_id 断言改为 404 + 非法 JSON 400 入账断言（P-15~19、Z-06）。

### 基础设施
- zip-reader.mjs：数据区越界校验（Z-01）。
- start-novel-studio.cmd：Node 版本校验 + 就绪轮询（Z-03）。
- package.json：version 0.9.1、dev 脚本 `node --watch`（Z-05）。
- novel-studio-icon.ps1 / create-desktop-shortcut.ps1：补 UTF-8 BOM（Z-04，见下方更正）。
- 日志「一键清空」同步清空滚动文件（Z-07）；测试数据卫生说明（Z-08）。

## 经复核不成立 / 已修正的结论

- **Z-04（icon 脚本编码）**：经字节级核查，`novel-studio-icon.ps1` 实为合法 UTF-8 无 BOM，此前「GBK 乱码」判断源于 PowerShell 5.1 `Get-Content` 按 ANSI 读取的显示假象。真实问题是「无 BOM 的中文 .ps1 在 PS 5.1 下按 ANSI 误读」，已按 install.ps1 同款方案补 BOM 解决。
- **F-03（导入 XSS）**：TXT/MD/EPUB 导入路径入库前已过 `textToHtml` 转义（server.js:1509），该路径本无漏洞；残余风险在粘贴与 `chapter_save` 通道，前端 sanitizeEditorHtml 已覆盖。
- **F-07（部分字段 PUT）**：后端 `updateRow` 本就是部分更新（仅更新 `data[f] !== undefined` 字段），前端假设成立；已补注释固化契约。

## 验证

- `node --check` 全部 11 个 JS 文件：通过。
- 后端实测（临时数据目录 + OV 禁用 + curl/node fetch）：
  - 服务启动、作品/章节 CRUD、事件幂等去重（`duplicate:true`）✓
  - 非法 work_id 写事件 → 404「作品不存在」（修复前 500）✓
  - 跨作品 volume 归属 → 400「卷不属于该作品」✓
  - 非法 JSON 请求体 → 400 ✓
  - 红线嵌套量词 → 400 ✓
  - 导出保留段落结构（多行）✓
  - API Key 掩码 `sk-abc…ijkl` ✓
  - 日志 lifecycle 可查询（缓冲冲刷正常）✓
- 插件子代理：`node --check novel-tools.mjs`、plugin.json JSON、install.ps1 ParseFile 均通过。
- 前端子代理：`node --check public/app.js` 通过。

## 说明与局限

- `harness-plugins/novel-writing/test/smoke.mjs` 的完整 23 组断言在本会话无法直接运行：沙箱禁止 Node `child_process.spawn` 以 piped stdio 捕获子进程输出（`spawn EPERM`）。已通过「后台起服务 + 等价 curl/node fetch 实测」覆盖关键回归点；smoke.mjs 本身已同步更新断言（非法 work_id 404、非法 JSON 400 入账、性能断言放宽）。
- 未改动的外部依赖：dsh 仓库本体、OpenViking 服务器、`@openviking/dsh-memory-plugin`（不在本仓库）。
- 所有改动均为代码修复，未改动 `data/` 数据库与备份。
