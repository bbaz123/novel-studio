# 时态故事状态重构 · T8 验收映射与交付审计（AC-01 – AC-48）

> 规格来源：`架构重构.md` §12（T8 综合验收与交付审计）、`方案.md` §17（AC-01–48 验收矩阵）、`方案.md` §18（阶段门槛）。
> 执行纪律：`AGENTS.md`（最小必要修改 / 零计费 / 绝不触碰真实 `data/` / SKIP ≠ PASS）+ 本任务《最高优先级修改范围锁》。
> 任务起点：分支 `refactor/p0-p6`，HEAD `7d61390ccf0c52048c1a2df92c23701a684656a9`（T0 基线见 `docs/temporal-refactor-audit.md`；本次 T0–T8 期间工作区原先干净、无用户未提交改动）。

本文件把 AC-01–AC-48 逐项映射到**真实测试文件、用例与运行命令**，并披露 SKIPPED / NOT VERIFIED / SCOPE_BLOCKED 与已知限制。
“通过”只表示对应命令在本轮 T8 实际执行且退出码为 0；所有语义结论来自测试输入本身，不来自“看起来正确”。

## 1. 环境与隔离口径

| 项 | 值 |
|---|---|
| 操作系统 / CPU / 内存 | Windows（win32 x64）· AMD Ryzen 7 5700X 8-Core · 31.9 GB |
| Node | v24.19.0（`node:sqlite` DatabaseSync，无新增依赖） |
| 计费 | 全部自动化测试**零计费**：本机脚本化 stub provider / fake model；无真实模型或付费端点调用 |
| 数据隔离 | `NOVELSTUDIO_DATA_DIR=mkdtemp` 临时目录 / `ci-isolated-run` 隔离实例 / 进程内临时库；日志与追踪也在同一临时目录内断言 |
| 真实 `data/` | 所有命令不写入真实库；`verify-all` 的 `--live-db` 指向真实库的**只读临时副本**（`Copy-Item data/novel.db → %TEMP%`），不直接打开真实库 |
| 依赖 | `package.json` / lockfile 未修改；未新增任何 npm 依赖 |

## 2. T8 实际执行的命令与结果

（本节数字由 T8 最终复跑产生；逐个子套件计数见对应日志与下方各表。）

| 命令 | 退出码 | 结果摘要 |
|---|---|---|
| `node scripts/test-temporal-refactor.mjs` | 0 | 15 个子套件全部通过（含新增 16 号） |
| `node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3757` | 0 | 30 通过 / 0 失败 |
| `node frontend-test.mjs` | 0 | 346 通过 / 0 失败（T6-1..T6-18、T7-1..T7-11） |
| `node scripts/ci-offline-checks.mjs` | 0 | 50 通过 / 0 失败 |
| `node .p1-baseline/test-approval-boundary.mjs` | 0 | 50 通过 / 0 失败 |
| `node .p1-baseline/test-host-contract.mjs` | 0 | 契约 1.19.0 · 28 通过 |
| `node .p1-baseline/check-utf8.mjs` | 0 | 通过 |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后复跑） | 0 | 354 个改动全部有归属（含本验收文档）；`docs/phase-map.md` 与阶段数据一致 |
| `node scripts/ci-isolated-run.mjs --port 3739 -- node .p1-baseline/verify-all.mjs --live-db <真实库只读副本>` | 1 | 通过 49 / 未通过 1 / 跳过 6。唯一未通过＝既有 P0–P6 条目「连续性预检在真实作品上成立」：真实库 work#18 第 1–6 章正文为空占位（`<p><br></p>`，`updated_at=2026-09-25`），判据要求的 `system_frequency` 命中必然无法出现（环境前置不满足；guard 源码自基线零 diff，非本任务改动）。6 条 SKIP 为脚本口径的外部前置缺失，见 §7。 |

> `verify-all` 首跑为 48 通过 / 2 未通过：另一项（`docs/phase-map.md` 过期）已 `--write` 重生成后复跑通过；上表为最终口径。该未通过条目与 AC-01–48 无关（它测的是既有 continuity-guard 对真实作品数据的对照），不计入任何 AC，如实披露于 §7。

## 3. AC-01 – AC-48 逐项映射

> “用例”列给出该 AC 最直接的证据用例；完整清单可 `rg "AC-xx" tests/temporal` 追溯。
> 所有 HTTP 证据都走真实端点 → 真实生产调用链（Save → afterTemporalContentSave → 提案/确认 → 投影/历史），模型一律为本机 stub。

| AC | 场景（方案 §17） | 测试文件与代表用例 | 结果 |
|---|---|---|---|
| AC-01 | 第 5 章存活、第 10 章战死 | `tests/temporal/02-history.test.mjs`「AC-01：第 5 章存活 / 第 10 章战死」；`04-http` H5c–H5e | 通过 |
| AC-02 | 新稿把死亡改到第 5 章 | `02-history`「AC-02：新稿死亡、原历史提交仍存活」；`04-http` H8a–H8d | 通过 |
| AC-03 | 写作章前与阅读章后 | `02-history`「AC-03：章前不含本章结尾事件」；`04-http` H6/H6b；`12-context` C1/C2 | 通过 |
| AC-04 | 无姓名接应依赖存活 | `08-impact-analysis` 夹具 A（含「第6章确实被送入模型复核」）；`09-impact-http` G2 夹具A | 通过 |
| AC-05 | 无姓名且任务独立 | `08-impact-analysis`「AC-05 夹具B：保留原文、新增验证绑定」 | 通过 |
| AC-06 | 第 7 章依赖已修订的第 6 章 | `08`「夹具C：第7章复核输入使用第6章候选提交」；`09` G3 | 通过 |
| AC-07 | 第 8 章人物直接参与行动 | `08`「AC-07 夹具D：显式出场结合叙事时间报告冲突」；`09`「G2 第7章初筛报告显式冲突」 | 通过 |
| AC-08 | 回忆/梦境/引用/转述 | `08`「夹具 E：梦境 → needs_review，不误报复活」 | 通过 |
| AC-09 | 第 5 章主角尚未知情 | `03-integrity`「AC-09/AC-10：死亡不自动写『主角已知』」 | 通过 |
| AC-10 | 死亡与人物关系 | `03`「不自动删除师徒关系」；`07-proposal-binding` B1l 兼容投影 | 通过 |
| AC-11 | 五域同时变化 | `03`「AC-11：物品/知识/剧情线/伏笔/势力/披露同批确认后状态与快照一致」 | 通过 |
| AC-12 | 原事件被改写删除 | `02-history`「AC-12：新事件集不含旧事件；旧提交仍可回放」 | 通过 |
| AC-13 | 根事实尚未确认 | `05-save-pipeline`「AC-13」；`08`「AC-13 根事实未确认 → 仅 tentative」；`15-backfill-http` H4b | 通过 |
| AC-14 | 不点击重建不生成后文 | `08`「AC-14 后文生成适配器调用数为 0、正文 hash 不变」；`09` G4 | 通过 |
| AC-15 | 点击重建按钮 | `10-repair-runner`「AC-15/16」；`11-repair-http` H1/H2（后台逐章） | 通过 |
| AC-16 | 每章候选先更新再构造下一章 | `10`「第 N 章候选先入线，第 N+1 章输入从新前缀重建」；`11` H2/H4 | 通过 |
| AC-17 | 修复试图撤销根变更 | `10`「AC-17 根锁：拒绝」 | 通过 |
| AC-18 | 三次修订仍失败 | `10`「AC-18 有界停止（≤3）」「重复冲突指纹提前停止」 | 通过 |
| AC-19 | 预算/超时/非法 JSON | `10`「AC-19/21 预算与超时 → 明确暂停」「AC-19 模型超时如实停止」 | 通过 |
| AC-20 | 取消时模型恰好返回 | `10`「AC-20 结果不提交；主稿不变；未采纳产物保留」 | 通过 |
| AC-21 | 重启与 lease 超时 | `10`「AC-21 旧 worker fencing token 被拒绝」；`11` H7 取消/恢复 | 通过 |
| AC-22 | 重复点击/重试 | `10`「AC-22 幂等回执」；`11` H5 复用同一运行 | 通过 |
| AC-23 | 作者中途修改后文 | `10`「AC-23 候选判 stale（暂停），不得覆盖新编辑」 | 通过 |
| AC-24 | 章序/硬约束/根变更 | `10`「AC-24 旧运行 stale；不能用过期基线继续」 | 通过 |
| AC-25 | 最后一次应用中途故障 | `10`「AC-25 正文/状态/HEAD/审批/outbox 全部回滚；重试成功」；`11` H4 apply 原子切换 | 通过 |
| AC-26 | 正常完成后一次应用 | `10`「AC-26 一次应用；旧稿可恢复」；`11` H4 | 通过 |
| AC-27 | 回滚时已有新编辑 | `10`「AC-27 CAS 拒绝且不覆盖；保留恢复候选」；`11` H4 撤销产生恢复提交 | 通过 |
| AC-28 | 所有正文写入口 | `06-http-save-entries` G1（PUT）/ G4（chapter_save）/ G5（版本恢复）/ G6（POST chapters）/ G9（旧字段 409/命令化）/ G10（模型开关）；`04-http` H4 | 通过 |
| AC-29 | 格式修改或重复保存 | `06` G1m–G1p（去重/沿用事件/不重复分析）；`05`「AC-29」 | 通过 |
| AC-30 | 插章/删章/跨卷移动 | `01-pure`「唯一章序」「orderOfCommit 使用提交自己的章序版本」；`03`「AC-30 跨卷移动」 | 通过 |
| AC-31 | 状态 hash 相同但来源改变 | `01`「state_content_hash 与 lineage_hash 严格分开」；`03`「AC-31」；`08`「AC-31 原生成来源保留、新增验证来源」 | 通过 |
| AC-32 | 旧上下文含未来信息 | `12-context-temporal` C1/C2/C5/C6/C7（角色/关系/剧情线/事件/伏笔/知识/披露/词条/检索/召回逐层过滤）；`13-context-cache` D4 | 通过 |
| AC-33 | 多世界线/POV/时点 | `12` C3（同请求同 context_id；换章/换边界/换视角不同）；`13` D1/D2（进程外推进 → 缓存外部版本变化） | 通过 |
| AC-34 | 外部索引尚未更新 | `13` D3（`unconfirmed_index`）/ D4（`future_chapter`） | 通过 |
| AC-35 | 独立导航拆分 | `frontend-test.mjs` T6-1..T6-4（独立渲染 / 只发自己的请求 / 旧键兼容不连带加载其余页） | 通过 |
| AC-36 | 正文下方状态面板 | `frontend-test` T6-5..T6-9（真实 API 字段、证据定位、全部状态展开、面板在正文编辑区之外不计入字数与导出）；`04-http` H7a–H7e | 通过 |
| AC-37 | 未出场/未来角色 | `03`「AC-37」；`12` C1（未来角色不进装配/阵容） | 通过 |
| AC-38 | 快速切章与迟到请求 | `frontend-test` T6-11/T6-11b（请求序号拦迟到响应；保留编辑器未提交状态）；T6-6e 诚实空态 | 通过 |
| AC-39 | 存量导入缺少生成上下文 | `14-backfill-migration` M2/M3（计划按序、出处打标、冻结修订不改正文、候选不写正式状态）；`15-backfill-http` H3a–H3d/H4 | 通过 |
| AC-40 | 旧字段最新状态迁移 | `14` M4（待确认候选 → 作者确认 opening 才进初始状态）；`15` H6c–H6g | 通过 |
| AC-41 | 迁移重复运行/故障/未启用 | `14` M1/M5/M8（迁移门禁、重复幂等、缺表响亮拒绝、未启用零写入）；`15` H1/H2；`12` C6 | 通过 |
| AC-42 | 未配置或关闭模型 | `05`「无模型可用 → not_run」；`06` G10；`15` H2c/M6 | 通过 |
| AC-43 | 伪造审批/跨作品/任意路径 | `05`「AC-43」；`06` G2/G3；`07` B5/B6（一次性审批、跨作品拒绝且不消费）；`09` G5；`10`「AC-21/22 审批消费失败不建档」；`11` H3/H7；`.p1-baseline/test-approval-boundary.mjs`（50/0） | 通过 |
| AC-44 | 手动更改角色状态/关系/剧情线 | `06` G9（无 chapter_id → 409；带 chapter_id → author_correction 生效）；`05`「手工更正走统一命令入口」；`07` B3d | 通过 |
| AC-45 | 只采纳部分且操作相互依赖 | `06` G2c/G2d（旧提案拒绝且 HEAD 不动）；`07` B6b/B6c（事件子集确认 → 400）；`10` AC-25 全量回滚 | 通过 |
| AC-46 | 业务日志/API 错误/追踪无泄漏 | `16-log-hygiene` G3（追踪：正控 buildNovelContext/callAI + 无正文/样文/key/完整 prompt）、G4（app_logs + 滚动日志文件）、G5（失败路径诊断可见 + 仍无泄漏）；共 33 断言 | 通过 |
| AC-47 | 原有 guard 不降级 | `ci-offline-checks`（50/0，含既有确定性审查用例）；`test-approval-boundary`（50/0）；temporal 套件的模型侧 403 / 旧语义未启用作品逐字节不变断言；`verify-all` 除「连续性预检在真实作品上成立」外全部通过（该项因真实库前六章正文为空占位而环境前置不满足，见 §7；非本任务改动） | 通过（偏差项见 §7） |
| AC-48 | 合成大作品与关闭开关 | `scripts/perf-temporal-baseline.mjs --size 100/500/1000`（EXIT=0，见 §4）；`package.json`/lockfile `git diff` 为空；真实 `data/` 未触碰（见 §1 隔离口径与 §7） | 通过（确认路径已优化：1000 章 1042.2 → 32.75ms/章；残余见 §4） |

## 4. 性能基线（AC-48 / 架构重构 §12.1）

命令：`node scripts/perf-temporal-baseline.mjs --size <100|500|1000>`（合成正文、`mkdtemp` 临时库、零模型；输出 `PERF_JSON` 行）。
环境：Node v24.19.0 · win32 x64 · AMD Ryzen 7 5700X 8-Core · 31.9 GB RAM。

**本轮（2026-09-30 22:25–22:27，确认路径优化后）复跑：**

| size | 正文 | 库体积 | 保存后处理（总/均） | 逐章确认（总/均） | 末章查询 | 中间章查询 | 可信前缀报告 | 章节面板 | 峰值 RSS | 总墙钟 |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 83.8k 字 / 215 KiB | 2.86 MiB | 198.97ms / 1.99ms | 361.74ms / 3.62ms | 2.52ms（101 条 / 13 SQL） | 1.92ms（52 条 / 13 SQL） | 1.66ms（7 SQL） | 3.31ms（17 SQL） | 66.9 MiB | 0.76s |
| 500 | 424.1k 字 / 1082 KiB | 27.64 MiB | 4649.83ms / 9.30ms | 8954.51ms / 17.91ms | 12.56ms（501 条 / 17 SQL） | 9.80ms（252 条 / 16 SQL） | 9.40ms（9 SQL） | 14.63ms（21 SQL） | 145.0 MiB | 14.66s |
| 1000 | 849.5k 字 / 2166 KiB | 93.82 MiB | 18,589.46ms / 18.59ms | 32,748.85ms / 32.75ms | 23.37ms（1001 条 / 21 SQL） | 20.13ms（502 条 / 20 SQL） | 19.11ms（11 SQL） | 26.95ms（25 SQL） | 261.4 MiB | 54.02s |

复跑一致性：500 章再跑一次为 9148.56ms（均 18.30ms/章，±2%）；单章确认均值 3.62 → 17.91 → 32.75ms 的增速已随规模**减速**（优化前 16.75 → 174.9 → 1042.2ms 为加速型超线性）。

**优化前 → 后对照（同脚本、同环境口径）：**

| 指标 | 100 章 | 500 章 | 1000 章 |
|---|---|---|---|
| 逐章确认 均 | 16.75 → 3.62ms/章 | 174.9 → 17.91ms/章 | 1042.2 → 32.75ms/章 |
| 逐章确认 总 | 1674.79 → 361.74ms | 87,457.65 → 8954.51ms | 1,042,209.78 → 32,748.85ms |
| 末章查询 | 26.34 → 2.52ms（709 → 13 SQL） | 271.20 → 12.56ms（3509 → 17 SQL） | 793.44 → 23.37ms（7009 → 21 SQL） |
| 章节面板 | 32.21 → 3.31ms | 265.45 → 14.63ms | 786.05 → 26.95ms |
| 总墙钟 | 2.30 → 0.76s | 92.33 → 14.66s | 1055.31 → 54.02s |
| 保存后处理 均 | 3.26 → 1.99ms/章 | 6.25 → 9.30ms/章 | 9.11 → 18.59ms/章（见残余） |

**根因（已修复）：** 确认路径此前对每章做「逐绑定/逐事件裸 `prepare` + 全前缀归约 + 全量 pending JOIN + 逐行 overlay upsert + 全量章序哈希」——每次调用重编译 SQL，且每章重复读取整个前缀，单章成本随章数加速膨胀。修复为性能等价改写（不改语义、不改内容寻址 ID）：按 SQL 文本缓存预处理语句（`ai/story-state/temporal/stmt.mjs`）；前缀批量预取绑定/事件/修订 + 内存归约（`history.mjs`、`event-store.mjs` 的 lite 批量读）；pending 索引一次建好按章判定；影响分析下游批量预取与批量落库（`impact.mjs`、`dependencies.mjs`）；`orderHash`/`stateHash` 懒算复用（`order.mjs`、`snapshot.mjs`）；批量归约 `reduceBatchInPlace`（`reducer.mjs`）。

**等价性证据：** 内容寻址 ID 与状态哈希逐字节黄金对照（`golden.mjs --size 120` 导出与 `golden-before.json` 对比）连续 6 次（check1–check6）`identical: true`，即 ID/哈希/清单内容未因优化改变。

**残余（如实披露）：**
- 确认与查询仍按「前缀规模」读取（总量仍为 O(N²)·小常数，每前缀章约 0.03ms 量级）；每章另有约 1.5–2ms 固定事务落盘成本（WAL `synchronous=FULL`，实测 300 事务 600ms vs `OFF` 6ms，属线性常量而非超线性）。未做增量状态缓存（超出本次范围）。
- `保存后处理`（本次未作为优化目标）在 500/1000 章的平均每章耗时高于优化前（6.25→9.30ms、9.11→18.59ms；100 章反而 3.26→1.99ms 更快）：保存路径的 `pendingSaveIndex` 按前缀规模扫描 pending 行，属同一「前缀读取」残余；1000 章下单次保存仍约 19ms（交互不可感知），未进一步优化。
- 未在 1000 章规模跑 HTTP 端到端（只跑了同一后端的进程内 API，与生产共用代码路径）。

读数口径（脚本内计数）：`sql_statements_*` = 语句**执行**次数（`run/get/all` 原型计数）；语句**编译**次数单独记在 `sql_prepare_count_total`（读取路径启用语句缓存后二者不再相等）；RSS = `process.memoryUsage().rss` 采样峰值；库体积 = 运行结束时 `novel.db` 文件大小；正文为脚本合成文本（非用户作品）。

## 5. 失败路径的可见诊断（架构重构 §12.1）

| 失败形态 | 诊断出口（真实后端字段 / 日志 kind） | 本轮证据 |
|---|---|---|
| 迁移失败/缺表 | `PUT /api/novel/state/temporal` → 503 + `migration.missing_*` 清单，配置不改；`sessionSummary`/启动日志 `lifecycle` | `14` M1/M8；`15` 无；`04` H1b |
| 任务（分析）失败 | 提案 `analysis.status=failed` + `analysis.error`（`GET /api/novel/state/proposal-groups`）；保存不受影响 | `16` G5a/G5b |
| 审批失败/拒绝 | 确认/应用响应 `ok:false` + `decision:rejected` + `reason`（不静默 200） | `16` G5c；`07` B4/B5/B6；`11` H3 |
| AI 错误（API 错误日志） | `app_logs.kind=ai_error`（含 `context.action` / `context.endpoint`）；`GET /api/ai_errors` | `16` G5d–G5f |
| 取消 | `repair` 运行 `status=cancelled`（断点保留，不算重建完成）；已取消运行签发 apply 审批 → 409 | `11` H7；`10` AC-20 |
| CAS 冲突 | apply/回滚被拒并保留恢复候选（不覆盖新编辑） | `10` AC-27；`11` H4/H6 |
| 租约失效/旧 worker | 旧 fencing token 回写 → `FENCED` 拒绝；恢复从持久断点继续 | `10` AC-21 |
| 外部投影落后 | `projection_outbox` 状态（pending/failed + `last_error`）/启动 `projection_recovered` 日志 | `10` AC-26（同事务 outbox）；`server.js` 启动恢复路径（既有 `ov` 机制） |

## 6. 日志与追踪卫生（AC-46 细目）

`tests/temporal/16-log-hygiene.test.mjs`（33 断言，退出码 0）用**哨兵 + 正控**验证而非“搜索关键字”：
- 哨兵：正文甲/乙/丙、样文、API key 各一个唯一合成串；先用正控证明它们**确实进过真实链路**（分析请求携带正文、样文进创作上下文装配、key 是真实配置值），再扫描日志/追踪文件本体。
- 追踪（`debug-trace` JSONL）：正控见 `buildNovelContext` / `callAI` 节点；随后断言无任一哨兵、无抽取 prompt 的系统/用户标记（长文本只留长度）。
- 日志（`app_logs` 查询 + `data/logs/app-*.log` 文件）：无任一哨兵、无 prompt 标记；AI 错误历史同样干净。
- 失败路径（模型 500）：日志/错误历史仍无泄漏；错误本身带可定位 `action/endpoint`。

## 7. SKIPPED / NOT VERIFIED / SCOPE_BLOCKED

| 项 | 状态 | 原因与影响 |
|---|---|---|
| 真实浏览器人工点击（五组导航 / 面板 / 重建按钮的浏览器端交互） | SKIP | 环境无浏览器；按架构重构 §10.4 允许保留 DOM stub 交互测试：`frontend-test.mjs` 用真实事件委托 + 网络 mock 覆盖点击/渲染/竞态（T6-1..T6-18、T7-1..T7-11）。未声称已人工点击。 |
| 插件工具路径携带时态游标（`harness-plugins/novel-writing/novel-tools.mjs`） | SCOPE_BLOCKED | `harness-plugins/**` 属负清单；T5 已在 `docs/temporal-refactor-progress.md` 记录目标文件、最小改动与阻塞范围。服务端过滤与四个工具端点已通过（12 C5）。 |
| temporal 专项真实模型语义评测 | NOT VERIFIED（未运行） | 零计费纪律下不调用真实付费模型；项目既有同类入口的授权后跑法见 `docs/golden-novel-regression-2026-09-26.md` §9 U1。离线编排契约由 `08`/`09` 的确定性 fake 验证（验证输入而非固定成功）。**不宣称真实模型对文学因果的理解已被验证。** |
| `verify-all` 条目「连续性预检在真实作品上成立」（既有 P0–P6 continuity-guard，非本任务功能） | NOT VERIFIED（环境前置不满足） | 只读副本复跑（`node .p1-baseline/verify-continuity-guard-on-real-data.mjs --db <只读副本> --verbose`，EXIT=1）：命中 4 / 漏报 1 / 误报 0。唯一漏报＝第五章 `system_frequency`（chapter id=123）——该章正文为 11 字符空占位 `<p><br></p>`（`updated_at=2026-09-25T05:57:38Z`，早于本任务基线，也早于 09-30 18:11 真实库事件），判据所需正文命中必然无法出现。`ai/continuity-guard*.mjs` 与该验证脚本自基线 `git diff` 为空 → 非本任务引入；不修改真实库以凑通过。本任务全部时序测试（§3）不依赖该条。 |
| `verify-all` 中需要外部前置的条目（如 harness 并发闸门需 `--gate-base` + 隔离确认） | SKIP（按脚本口径） | 见 §2 该命令输出；脚本设计即“缺前置标 SKIP，不伪装 PASS”。 |
| 1000 章 HTTP 端到端负载 | NOT VERIFIED | 性能基线用进程内 API（与生产同一后端函数）；未在 1000 章规模走完整 HTTP/前端链路。 |

## 8. 已知限制与维护入口

1. 确认路径超线性已修复（2026-09-30，用户授权后；数字与残余见 §4）——1000 章全书逐章确认从 1042.2ms/章 降至 32.75ms/章，单章交互 <35ms；残余为每章前缀读取 + 固定事务落盘，未做增量状态缓存。
2. `filterRowsByCursor` 对“归属不明”的旧账在启用作品上 fail-closed（未知 ≠ 已知），需经存量重建补归属（T5 限制）。
3. 语义召回过滤依赖索引 URI 可解析章节号（`/chapters/<id>.md`）；不可解析则拦为 `unattributed`（T5 限制）。
4. 兼容投影只覆盖 `characters.status` 与 `character_relations.relation/description`；剧情线无安全旧字段，如实不写（T2 决策）。

维护入口：
- 总测试入口：`node scripts/test-temporal-refactor.mjs`（显式清单；空清单非零退出）
- 测试用例目录：`tests/temporal/01..16`；前端：`node frontend-test.mjs`
- 性能基线：`node scripts/perf-temporal-baseline.mjs --size 100|500|1000`
- 状态契约 / 迁移与备份：`docs/temporal-state-contract.md`（§7 迁移门禁与回退三义、§8 存量迁移与 bootstrap）
- 阶段映射与回滚：`.p1-baseline/verify-phase-map.mjs` → `docs/phase-map.md`（TT 阶段）
- 执行审计底稿：`docs/temporal-refactor-audit.md`、`docs/temporal-refactor-progress.md`（逐阶段命令与 Scope Audit）
