# 保存功能事故与修复（2026-10-02）

> 一句话：**第三章 #121 的正文被整章写成了 `<div><br></div>`（0 字）**，而"编辑器为空就暂停保存"
> 的那道护栏当时就在代码里、也已经跑在浏览器里 —— 它没有拦住。本文记录取证、恢复与**为什么没拦住**。

## 一、事故与取证（全部为库内实测，非推测）

| 事实 | 证据 |
| --- | --- |
| 正文被清空 | `chapters#121.content = '<div><br></div>'`（15 字节，可读字符 0），`updated_at = 2026-10-02T13:51:12.912Z` |
| 清空**之前**库里就是空的 | `chapter_save_versions#50`（manual，13:50:00.181Z）存的是"覆盖前那一版"，内容 11 字节 = 空 |
| 仍有两份完整副本 | `#48` manual 13:38:50（3982 字）、`#49` draft 13:42:01（4009 字）；两者文字不同，重合度 ≈ 0% |
| 清空**不是**某次"确认清空" | `#50` 的 kind 是 manual（编辑器保存通道），且当时还没有任何"显式清空"入口 |
| 事故前最后一次人工保存成功 | `#48` 由"手动保存"落库（13:38:50），路径 = `PUT /chapters/:id` + `POST /chapter_versions` |

恢复材料齐全（版本表分区保留 manual/draft/auto 各 10/10/20 份），因此**可完整恢复**。

## 二、恢复动作

1. 备份现场（**先备份再动手**）：
   - `data/backup-pre-savefix-20261002215726/`（含 `novel.db` + `novel-clean.db` 一致性快照）
   - `data/backup-pre-ch121-restore-20261002215838/novel-clean.db`
2. 按作者选择，把 `#48`（13:38:50 手动保存那一版）写回正文：
   `POST /api/novel/chapter_save`（作者通道）→ HTTP 200，`version_id = 51`
3. 逐字节校验：恢复后 `chapters#121.content === #48.content`（4598 字节 HTML / 3982 可见字）→ **一致**
4. `#49`（AI 那版）保持"未应用的生成稿"，仍在正文页顶部的「取回生成稿」里，一键可取回。

## 三、为什么护栏没拦住（根因，逐条可指到代码）

护栏当时的实现是：**在自动保存的定时器里**判断
`编辑器可见文本为空 && wordCount(state.chapters[该章].content) > 50`，命中就弹 `confirm()` 问作者。
它在这次事故里必然失效，原因有四条，任何一条都足以让"整章被清空"发生：

1. **判据用的是内存里的 `state.chapters[].content`** —— 这份内存稿会被刷新、会被别处的写入改成空。
   一旦它已经是空的（例如之前已经发生过一次空写），`> 50` 永远不成立，护栏**永久失效**且不再有任何提示。
2. **它只看得见一条写入通道**：编辑器自动保存（`PUT /chapters/:id`）。
   而写正文的通道一共**五条**：`PUT /chapters/:id`、`POST /novel/chapter_save`（审稿合并 / 批量生成写回 /
   取回生成稿）、`POST /novel/adopt`（AI 结果整次采纳）、`POST /chapter_versions/:id/restore`（恢复历史版本）、
   `POST /chapter_versions`（手动保存）。**手动保存这条自己就没有任何空内容判据**。
3. **路由层的"什么算空"判据是错的**：`chapter_save` 只挡 `!content.trim()`，而 `<div><br></div>`、`<p><br></p>`
   trim 后都非空 —— 看起来"有内容"，实际一个字都没有。
4. **`confirm()` 弹窗不是保护**：它弹在 800ms 防抖回调里，作者那一刻可能在切章、在别的视图、
   甚至只是回车确认了一个被打断的动作；而且"确定"按钮就是"覆盖整章"。

### 顺带查实的另外三处（都是"保存影响正常操作"的来源）

5. **导航闸门会把作者锁死**：`flushSave()` 在"空内容暂停 / 保存失败快照未清"时返回 `false`，
   而它被 20 多处导航调用（切章、切视图、命令面板、AI 工具、批量生成…）。
   于是任何一次保存异常都会让**整站导航失效** —— 这正是"保存功能十分混乱"的最大来源。
6. **跨通道的版本标记不同步**：批量生成写回 / 取回生成稿 / 采纳 / 恢复历史版本都会推进 `updated_at`，
   但本地 `state.chapters[]` 不跟着更新 → **下一次编辑保存必然 409**，
   而"冲突的另一方"其实是他自己刚做的那个动作（界面报"其他窗口修改了内容"，纯属误导）。
   另外 `POST /chapter_versions/:id/restore` 恢复正文时**根本不推进 `updated_at`**（版本标记原地不动）。
7. **自动快照的节流标记先落库**：`shouldAutoSnapshot()` 写在写入事务内、却先写节流时间戳；
   事务一旦回滚（时态锁/唯一约束/磁盘错误），这 90 秒的"兜底已留"记账**不会回滚** ——
   安全网被静默吃掉一次，而日志与界面都看不出来。

## 四、修复（服务端权威护栏 + 客户端非交互暂停 + 基线同步 + 闸门口径）

### 服务端（`server.js`）—— 以**库里的现正文**为准，覆盖每个写正文的入口

- 新增 `readableChars()` / `isBlankBody()` / `checkEmptyOverwrite()`：
  - "空" = 去掉全部标签后**没有可读字符**（汉字/字母/数字），`<div><br></div>`、`<p>&nbsp;</p>`、纯空白都算空；
  - "有正文" = 现正文可读字符 ≥ `EMPTY_OVERWRITE_MIN_CHARS = 50`；
  - 命中 → **拒绝写入**，返回 `409` + `code: 'EMPTY_OVERWRITE_BLOCKED'` + `current_chars`，正文一个字节不动；
  - `confirm_empty: true` 才放行（清空是合法操作，但**必须是作者显式选择**）。
- 接入三处：通用 `PUT /api/chapters/:id`（编辑器保存）、`POST /api/novel/chapter_save`
  （在**消费一次性审批之前**裁决：被拦下的请求不该吃掉审批）、`POST /api/novel/adopt`（采纳不接受空稿）。
- `sendError()` 支持附加机器可判字段（`code` / `current_chars`），客户端据此显示**补救动作**而不是猜文案。
- `chapter_save` 路由层的"缺少 content"判据改为"连字节都没有"，不再用 `trim()` 冒充"非空"。
- 自动快照节流拆成 `autoSnapshotAllowed()`（只读）+ `markAutoSnapshotTaken()`（真的落库之后才记账）。
- `POST /api/chapter_versions/:id/restore`：恢复正文时**一并推进 `updated_at`**（版本标记跟着走）。

### 客户端（`public/app.js`）

- **唯一写入出口**：新增 `writeChapterBody()`，自动保存 / 手动保存 / 确认清空 / 冲突重试全部走它；
  空内容判据只有一份，不可能再出现"手动保存没有护栏"这种不对称。
- **判据换成"本页见过的最长正文"**（`state.chapterBodyPeak`，只增不减，
  来源 = 编辑器 / 待保存快照 / 服务端载入的章节行），不再依赖会被改小的 `state.chapters[].content`。
- **交互改成"只暂停，不弹窗"**：命中就暂停写入、状态栏与恢复条同时说明，恢复条给出**两条一次点击的出路**——
  「取回历史版本」（`restoreLastSavedVersion`）与「确认清空本章」（`clearChapterBodyExplicit`，带 `confirm_empty`）。
  写入永远不经作者之外的手落到空稿上。
- **导航闸门只留两种拦人状态**：输入法组字中、409 真冲突（必须作者选一版）。
  空内容暂停与保存失败**不再阻止导航**，只给提示与出路。
- **基线同步** `refreshChapterBaselineAfterForeignWrite()`：批量生成写回、取回生成稿、采纳、恢复历史版本之后
  把本地章节行（含 `updated_at`）拉回服务端真值 —— 本人刚做的写入不再被自己误判成"其他窗口改过"。
  编辑器里还有未保存稿子时**不同步**（那正是乐观锁要保护的场景）。
- 空产出不再能替换编辑器：`applyAIReply` / `applyAIWritingArticle` 先判空，正文一个字都不动。

### 测试（`frontend-test.mjs`）

- 新增回归组 **P-EMPTY-1 … P-EMPTY-6**：编辑器清空时不落空稿且不替作者确认、
  被服务端拦下后进入可见暂停态、判空口径、唯一放行口必须带 `confirm_empty`、恢复条两条出路、导航不被锁死。
- 修掉两个**测试桩缺陷**（它们此前一直在制造假绿/假失败）：
  ① `El` 的 `innerHTML` setter 不同步 `textContent`，于是 `stripHtml()` 恒返回空串
  （所有"正文长度/可读字符"判据在测试里都是 0）；
  ② 与之连带的脆断言 `110c`（写死 harness 次数 = 4，实际取决于补足轮）改成不变量。
- 另外修正 `P-EMPTY-1` 的断言口径：护栏**有意**先发一次"问服务端"的探针请求，
  断言应钉"没有任何一次带 `confirm_empty` 的偷偷清空"。

## 四·补：第二轮报障——"修稿完成后无法直接加进正文，而是报错"（2026-10-02 晚）

**现象**：作者点「合并到正文 / 应用修稿」时，界面弹出
「本章编辑器是空的，已暂停保存（正文没有被覆盖）：原稿可用「历史版本 / 取回生成稿」找回；确实要清空本章请在恢复条里确认」，
读起来像是这条护栏把他的修稿挡住了。

**取证（库内实际状态）**：

| 事实 | 证据 |
| --- | --- |
| 修稿**最终是写进去了** | `chapters#121` 现为 4321 可见字，与修稿草稿 `#54`（4347 字）同源 **72%**；与上一版 `#55`（4009 字）仅 **1%** |
| 合并不经过编辑器 | `mergeReviewDiff()`（"合并到正文"那条）全程不读 `#editor-content`，直接 `POST /novel/adopt` 写 `newText` |
| 警报来自"内部等待落盘" | `adoptEditorContentImpl()` 第 1 步 `await flushSave()`；而 `flushSave()` 在 `state.editorEmptyBlocked` 存在时会先 `toast(...)` 再放行 |

**根因（两条，都是我上一轮修复引入的副作用）**：

1. **提示放错了层**：那句 toast 被写在 `flushSave()` 里，而 `flushSave` 同时被**导航**和
   **内部等待落盘**（采纳/合并）调用。于是"完全不经过编辑器"的合并操作也会报一句"编辑器是空的"——
   作者合理地把它读成"操作被拦住了"。
2. **暂停态是粘性的**：`state.editorEmptyBlocked` 只在"作者显式清空"或"采纳成功"时才清。
   作者把正文粘回编辑器之后它还挂着（那一刻编辑器确实非空），于是**之后每一次保存/导航都继续
   按"编辑器是空的"处理**，反复弹出这条与当下无关的提示。

**修复**：

- `flushSave()` 拆成两层：`flushEditorSaves()`（只把待写/在途的稿子落盘，**不产生任何界面提示**，
  供所有内部流程调用）与 `flushSave()`（导航闸门，在核心之上补提示）。
  `adoptEditorContentImpl()` 改用前者——合并这条路从此不会听到"编辑器是空的"。
- 新增 `clearEditorEmptyBlockIfStale()`：编辑器**此刻非空、且装的正是被拦下的那一章**时，
  自动清除暂停态与失败态，并刷新恢复条（过期的那条「🛡 已暂停」不再挂着）。
- `mergeReviewDiff` 与 `adopt` 的正文来源本来就是入参 `newText`/`html`（与编辑器无关），
  这一点由回归用例 P-EMPTY-10 钉住：**编辑器为空时合并，写进库的必须是修订稿，且零警报**。

**回归**：`frontend-test.mjs` 的 P-EMPTY 组扩到 **10 条**（新增 7/8/9/10），全部通过；
`node frontend-test.mjs` → ALL PASS。

## 五、验证（全部实际执行）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 前端全量测试 | `node frontend-test.mjs` | **ALL PASS**（含新增 P-EMPTY 六条） |
| 时态保存链路 | `node tests/temporal/05-save-pipeline.test.mjs` | PASS 8 / FAIL 0 |
| 端到端护栏冒烟（隔离端口 + 隔离数据目录） | `node .p1-baseline/smoke-empty-guard.mjs` | **11 ok / 0 fail**（PUT 拒绝、内容逐字节未变、只有标签也算空、`confirm_empty` 放行、空章照常写、`chapter_save` 拒绝、正常写回成功、`adopt` 拒绝、恢复历史版本不受阻） |
| 语法 | `node --check server.js / public/app.js / frontend-test.mjs` | 全部通过 |
| 线上实例（3737）实测 | `POST /api/novel/chapter_save` 带空稿 | `409 EMPTY_OVERWRITE_BLOCKED`，且 `chapters#121` 内容与 `updated_at` **均未变** |
| 恢复校验 | `GET /api/chapters/121` | 4598 字节，与 `#48` 逐字节一致 |

> ⚠️ `tests/temporal/04-http.test.mjs`、`06-http-save-entries.test.mjs` 在本机**未能跑起来**：
> 用例自起的服务（:3756）连接被拒（`ECONNREFUSED`），与本轮改动无关（改动前同样起不来）。
> 这两条的覆盖已被上面的端到端冒烟覆盖（同一批端点、同样的断言口径）。

## 六、备份与回滚

| 目录 | 内容 |
| --- | --- |
| `data/backup-pre-savefix-20261002215726/` | 事故现场的一致性快照 `novel-clean.db`（`VACUUM INTO`，`integrity_check = ok`） |
| `data/backup-pre-ch121-restore-20261002215838/` | 恢复动作之前的现场：`novel.db` + `-wal` + `-shm` **原始三件套** + `novel-clean.db`（`integrity_check = ok`） |

回滚方式：停服 → 用上述 `novel-clean.db` 覆盖 `data/novel.db`（若用三件套，先删掉 `data/novel.db-wal` / `-shm`）→ 启服。
本轮所有代码改动都是"拒绝写入"方向的，回滚代码不会造成数据损失。

## 七、需要作者知道的两件事

1. **清空章节现在需要显式确认**：编辑器被清空后自动保存会暂停，正文**不会被覆盖**；
   要真的清空，请点编辑器上方的「确认清空本章」（会先备份当前正文为历史版本）。
2. **未被修复的相邻项（本轮未动，避免范围外改动）**：
   - `tests/temporal` 里的 HTTP 用例在本机起不来（自起服务 :3756 连接被拒 `ECONNREFUSED`），
     与本轮改动无关（改动前同样起不来）；同一批端点的覆盖由 `.p1-baseline/smoke-empty-guard.mjs` 承担。
   - 编辑器保存（乐观锁 `_if_updated_at`）与 AI 写入（内容指纹 `content_hash`）是**两套并发的判据**。
     本轮给它们补了"写后同步基线"这一层协调，但没有合并成一套；若后续要合并，应以内容指纹为准
     （它不随时间戳漂移，也是采纳通道正在用的判据）。

> **更正（2026-10-02 晚）**：本文早先版本把 `GET /api/harness/status` 里调用的 `modelSwitchLoad()`
> 写成"未定义、会让端点 500"——**那是我写错了**。该函数在 `harness.js:602` 正常导出，
> 端点实测返回 `200 {"ok":true,"available":true,"built":true,...}`。错误来源是我只看了 `server.js`
> 的 import 行就下结论，没有实际调用该端点验证。

