# OpenViking 三条调用链：配置、scope、重试与证据

> **用途**（任务书 §19.3）：把三条 OV 链、配置来源、scope 边界、失败重试语义与**本次实际证据**写清楚，
> 并明确哪些结论是**离线可复验**的、哪些是 **BLOCKED**（不能声称）。
> **采集方式**：代码只读 + 本地 OV stub 实测（零计费、零真实 namespace 写入）；共享资料链另有 2026-09-28 真机验证（真实 OV v0.4.21 + 隔离实例，见 §3）。
> **历史说明**：2026-09-27 增强轮采集时本机 OV 服务未监听（`1933` 端口 TCP 探测，`.verify-enh/ov-port-probe.log`），**该轮**未对真实 OV 发起任何请求；2026-09-28 知识库专项期间 OV 在线，资料链在隔离实例上做了真机验证。

## 0. 三条链

| 链 | 生产方 | 消费方 | 内容 | 落点 |
| --- | --- | --- | --- | --- |
| **A. 作品资源链** | 工坊 `openviking-sync.js` | 工坊装配器 `server.js` 的「相关记忆检索」层 | 作品六类数据的 Markdown 渲染：`meta.md` / `long-memory.md` / `events.md` / `outline.md` / `settings/<termId>.md` / `characters/<charId>.md` / `world/<entryId>.md` / `chapters/<chapterId>.md` | `viking://user/default/resources/novel-studio/<workId>/...` |
| **B. 会话链** | dsh 会话（`@openviking/dsh-memory-plugin` 采集） | 新会话的语义召回 → 最终模型输入 | 会话在合法 commit 条件下采集的长期记忆 | 同一共享记忆库（user 域） |
| **C. 共享资料链** | 工坊 `openviking-sync.js` 的 `getLibraryRecall`（导入由 `/api/novel/library/import/confirm` 写入共享资料根） | 工坊装配器的「参考资料（非本书事实）」层（门控，默认关闭）+ 模型工具 `novel_library` 查回原文窗口 | 作者显式导入的跨作品写作资料（`.md`/`.txt` 规范化后的 Markdown） | `viking://user/default/resources/novel-studio-library/<分类>/<slug>.md`（与作品子树**物理隔离**的兄弟根） |

三条链的**凭证解析链逐档对齐**（`openviking.js` 头部注释，2026-09-18 与插件 `shared/credentials.mjs`
逐行核对）：① `OPENVIKING_*` 环境变量（受 `OPENVIKING_CREDENTIAL_SOURCE` 约束）→ ② 工坊内设置（AI 设置页 OpenViking 卡，
写进 `app_settings`，由 `server.js` 注入）→ ③ `~/.openviking/ovcli.conf` → ④ `~/.openviking/ov.conf` → ⑤ 默认 `http://127.0.0.1:1933`。
所以工坊、GUI dsh 会话、headless dsh 任务读写的是**同一台服务器、同一个记忆库**；共享资料根与作品子树在同一服务器内物理隔离。

## 1. 配置、scope 与环境开关

| 项 | 值 / 变量 | 说明 |
| --- | --- | --- |
| endpoint | 默认 `http://127.0.0.1:1933` | 可被环境变量 / 工坊设置 / 配置文件覆盖 |
| peer / actor | `OPENVIKING_PEER_ID` 或 `NOVELSTUDIO_OPENVIKING_PEER_ID`，再退 `ovcli.conf` 的 `actor_peer_id` / `peer_id` | 隔离测试用 `NOVELSTUDIO_OPENVIKING_PEER_ID=ci` |
| 作品子树 | `<OV_ROOT>/<work_uri>/...`，`OV_ROOT = viking://user/default/resources/novel-studio` | 检索查询用 `target_uri` 限制在作品子树 |
| 总闸 | `NOVELSTUDIO_OV_DISABLED=1` | 停用整个 OV 集成（隔离测试/冒烟用，绝不写真实记忆库） |
| 资料根 | `viking://user/default/resources/novel-studio-library`（`SHARED_LIBRARY_ROOT`；注册表 `ai/library/library-roots.mjs`） | 检索查询用 `target_uri` 限制在资料根；形状闸门（恰两层 `<分类>/<slug>.md`、任意层级 `.`/`_` 前缀拒绝）只收紧不放宽 |
| 资料层开关 | `library_enabled:<workId>`（`app_settings`，缺省即关闭） | 未开启的作品装配与接入前逐字节一致（`.p1-baseline/verify-library-identity.mjs`） |
| 来源校验 | `ai/openviking/recall-meta.mjs`（纯函数） | 逐行核对 work / scope / canon / 时间语义；证明不了来源**拒绝进入**（fail-closed），被拦条目留审计原因 |
| 破坏性操作 | `planRebuild` + `ov_projection_audit` | rebuild 默认 **dry-run**；删除前逐条证明归属；模型侧 403 |
| 去重 | 贡献记录的来源感知去重 | 默认 `dedup_action: 'off'`（**只标注不删除**，旧作品行为不变）；作者打开 `ov_recall_dedup` 后才真正去掉重复条目 |

## 2. 失败与重试语义

| 场景 | 行为 | 可观测入口 |
| --- | --- | --- |
| OV 服务器离线（写入） | 落本地 pending 队列 `data/openviking-pending.jsonl`；服务器恢复后自动重放（与 dsh 插件离线队列同思路） | `pendingQueueLength()`、`GET /api/novel/projections` |
| 投影失败 | `projection_outbox` 记录 pending / failed + 最近错误；`POST /api/novel/projections/retry` 复位并续跑 | `GET /api/novel/projections` |
| 重启后恢复 | outbox 持久化，重启不丢待办 | `test-adopt-atomic.mjs`（B 段：outbox 恢复） |
| 重复投递 | 幂等：`adoption_operations` 幂等键 + outbox 状态机 | 同上（同 key+同 payload 重放不重复写；同 key 不同 payload 冲突） |
| 召回脏数据（跨书 / 未来章 / 候选 / 布局不明） | **拒绝进入 assembled**，留审计原因 | `test-ov-recall-boundary.mjs` |
| rebuild 范围证明不成立 | **拒绝执行**（不删任何东西），dry-run 报告待删除集合 | `POST /api/novel/projections/rebuild`（`confirm` 才执行） |
| OV 服务器离线（资料导入确认） | confirm 拒绝（409）且**零写入**；dry-run 仍可本地扫描；`search` 走关键词兜底且不报错 | `test-library-import.mjs` G 段 |
| 资料写入后未立即可召回 | 异步索引：写后约 30 秒内可被召回（P0 实测 `wait:true` 阻塞 28.9s）；状态端点显示 `ov_indexed_at:library` | `GET /api/novel/library/status` 的 `index` |
| 资料文件缺失 | 默认只标 `marked_missing`（不删记忆库文件、不删登记行）；作者 `?confirm=1` 才删除；OV 不可用时 409 保留登记行 | `DELETE /api/novel/library/doc/:id` |
| 资料根上的删除证明 | `planRebuild` 对资料根**显式拒绝**（`library_scope`）——全量重建绝不动共享资料 | `test-ov-recall-boundary.mjs` 资料根用例 |

## 3. 证据

**离线（零计费，本地 OV stub，不碰真实 namespace）**

- `.p1-baseline/test-ov-recall-boundary.mjs` → **54/54**：跨书、未来章、候选内容、rebuild 范围证明 + 资料根用例（形状拒绝 / OV 伴随文件拦下 / 跨层互拒 / rebuild 拒绝资料根 + HTTP 门控 F 段）。
- `.p1-baseline/test-context-contributions.mjs` → **27/27**：召回来源进运行时贡献记录、来源感知去重、默认行为不变（只记结构：来源 id / 版本 hash / 长度 / 去重标识 / 使用或省略原因；不记完整正文与密钥）。
- `.p1-baseline/test-adopt-atomic.mjs` → **36/36**：正文 + 提案 + 投影 outbox 同一事务；OV 失败时正文保留、投影可见待恢复、重启可重试。
- 环境探测（只做 TCP 连接，不发任何请求）：`1933` **未监听**；`3737` 正式实例**未监听**（2026-09-27 当晚复测，见 `.verify-enh/ov-port-probe-run2.log`；该轮未对它们发起任何请求）。
- `.p1-baseline/test-library-import.mjs` → **34/34**：隔离实例 + OV stub 的共享资料导入链（扫描 / 计划 / 开关 / dry-run→confirm / 重导幂等 / 查回 / 删除 / 总闸关闭）。

**真机（2026-09-28 知识库专项；真实 OV v0.4.21 + 隔离实例，零计费，不碰作者真实记忆库）**

- `.p1-baseline/verify-library-realmachine.mjs` → **18/18**（证据 `.p1-baseline/verify-library-realmachine.result.json`）：写前 fail-closed（资料根必须为空）→ 只写共享资料根 3 篇 → 命中预览 → 装配出现资料层 → `readContent` 按行取回 → 删除后回读失败、根零残留；全程不动作品子树（作品/章节用 SQL 直插，不触发 `syncWorkFull`）。
- `.p1-baseline/verify-library-identity.mjs` → **4/4**：`library_enabled=0` 的作品 assembled + manifest 与接入前**逐字节一致**（1091 / 1081 / 1014 / 1071 字）。
- P0 探针 `.p1-baseline/probe-library-p0.mjs`（真实 OV，一次性临时文件，已删除并回读确认）：`write wait:true` 阻塞 28.9s、`find` 为文件级命中、`readContent` 按行计、删除即时生效。

**BLOCKED（不写 PASS）——真实 OV 双闭环**

任务书 §17.5 要求：作品资源链（测试哨兵 → 同步 → 等索引 → 作品限定检索命中 → 召回层出现 → 最终输入可验证）、
会话链（真实 DSH 会话采集 → 服务端处理 → 新会话召回）、以及 user/account/peer/work/chapter 的实际隔离；
并且"如果当前 OV 版本无法提供足够 namespace 隔离，不能把测试哨兵写入用户正式小说或共享长期记忆来强行验收"。

本次前提：② 已满足——用户 2026-09-27 授权「预算2元以内」，真实 DeepSeek 侧已做有限实机验收
（能力探针 7/0 + 整链写作冒烟 7/0，见 `docs/enhancement-acceptance.md` §6.2）；① 在 2026-09-27 增强轮未满足——当时本机 OV 服务未监听
（2026-09-27 复测 `.verify-enh/ov-port-probe-run2.log`，`3737` 同样未监听），当时无法同步与检索，OV-VLM 也未验证。
因此作品资源链（A）与会话链（B）的 live 闭环仍记为 **BLOCKED**，不声称通过（共享资料链 C 已有上述隔离实例真机证据，但它不构成 A / B 的 live 证据）；离线 stub 证据只覆盖"宿主侧判据与边界"，不覆盖"真实服务端行为"。

## 4. 复验命令

```powershell
node .p1-baseline/test-ov-recall-boundary.mjs        # 召回来源边界（本地 stub；含资料根用例）
node .p1-baseline/test-library-import.mjs            # 共享资料导入链（隔离实例 + OV stub，零计费）
node .p1-baseline/verify-library-identity.mjs        # 未开启资料层的作品逐字节不变
# 真机（需本机 OV 在线；写隔离实例，不碰作者真实记忆库；不进 CI）：
node .p1-baseline/verify-library-realmachine.mjs
node .p1-baseline/test-context-contributions.mjs     # 运行时贡献记录 + 来源感知去重
node .p1-baseline/test-adopt-atomic.mjs              # 投影 outbox 可恢复 / 幂等
# 只读环境探测（不发请求）：
node -e "const n=require('net');const s=n.connect({host:'127.0.0.1',port:1933,timeout:1500});s.on('connect',()=>{console.log('监听中');s.destroy()});s.on('timeout',()=>{console.log('未监听');s.destroy()});s.on('error',()=>console.log('未监听'))"
```
