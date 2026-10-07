# 修稿合并 · 空正文的章节永远合并不进去（2026-10-06）

> 作者报障原文（截图 21:47，右侧 toast）：
> 「这一章的正文在差异预览之后被修改过（或已读不到），为避免覆盖新内容，已拒绝合并。
> 这份修稿仍然保留：处理好正文后可以再点「合并到正文」重试。」——**再点多少次都是同一句**。
> 问：为什么？请修改。

本文记录取证、根因、修复与回归门禁。**结论可在活库上只读复算**（见 §5）。

> ⚠️ **同一天的后续修订（请以新版为准）**：作者在本文交付后进一步裁决
> 「**无论什么时候，只要是用户执行，就直接强制合并到正文**」。
> 因此本文 §3 F1、§4 的 107n/107o/107p 与 §8.2 所描述的「**仍然拒绝**」已作废 ——
> 现行契约是「**合并到正文没有任何拦阻**」，见 [`docs/review-merge-force-20261006.md`](./review-merge-force-20261006.md)。
> 本文 §1/§2 的取证与根因、以及 §3 F2（读取层区分"读不到"与"空正文"）**仍然有效**。

---

## 1. 症状

作品 #18 / 第 119 章（正文当时是 `<p><br></p>`，即**空章**）。作者走
「AI 写作（成文）→ 先审稿再应用 → 按确认清单修稿」这条**草稿链**，差异预览
（标题「按 11 条清单修改，实际改好 19 处」）打开后点「合并到正文」：

- 正文一个字都没写进去；
- 界面回「正文在差异预览之后被修改过（或已读不到）」；
- 按 toast 的建议再点一次，**结果完全相同**（不是偶发，是必然）；
- 活库里也没有任何本次采纳记录（`adoption_operations` 最新一条仍是 2026-10-01）。

作者最后的动作是**手工**把预览里的段落抄进编辑器（13:49:15 一次编辑器保存）。
这正是 `public/app.js` 里被反复警告的那个形状：手工抄写绕过了「旧稿留历史版本」的兜底。

## 2. 根因（一处判断写错，必然发生）

`mergeReviewDiff()` 的「原文保真闸门」（R02.3）在写入前重新取当前正文，与差异预览
生成时的底稿指纹比对；**不一致就拒绝**。旧判据把三件事写成了一个条件：

```js
// public/app.js（修复前）
if (current === null || !String(current).trim() || textFingerprint(current) !== baseFingerprint) {
  toast('这一章的正文在差异预览之后被修改过（或已读不到）…');
  return;
}
```

`!String(current).trim()` 把「**读不到**（`null`）」与「**正文是空的**（`''`）」当成同一件事，
于是：底稿是空正文时，预览时基线指纹 = 空串指纹、合并时当前也是空串指纹 ——
**两者其实完全相等，闸门却先被 `!trim()` 拦下**。

而草稿链的存在理由恰恰是「这一章还没有正文/待整章重写」：
`runArticleReview` 里 `fromDraft` 分支专门把**章节正文**（而不是草稿）固化成基线，
预览时它当然也是空的。两条正确的设计叠在一起，就成了
「**空正文的章节永远合并不进去**」，且 toast 给的出路（处理好正文再重试）在这条链上不存在。

同类形状 2026-09-27 修过一次（`docs/post-implementation-issues.md` ISSUE-03：
草稿链拿"草稿"比"正文"必然拒绝）；这次是同一个闸门的**另一半**：
基线取对了，但"空"被误判成"变过/读不到"。

## 3. 修复（两处，均最小改动）

### F1 · 闸门只按指纹判"正文有没有被改过"（`public/app.js` `mergeReviewDiff`）
> ⚠️ 已被同日《review-merge-force-20261006》取代：现在**不拒绝任何情况**，指纹只用于"如实告知"。

```js
if (current === null || textFingerprint(current) !== baseFingerprint) { …拒绝… }
```

- 指纹相等 = 这一章从差异预览到现在**一个字都没变** → 没有任何理由拦（空↔空自然也放行）；
- 真正要拦的两类仍然拦住：正文被删/读不到 → `current === null`；
  正文被改（**含被清空**）→ 指纹不等。

### F2 · 底稿读取区分「读不到」与「空正文」（`public/app.js` `revisionBaseArticle`）

```js
const row = await api(`/chapters/${target}`);
if (!row) throw new Error('读不到这一章的正文');   // 取不到就抛错（本函数头注释的既有契约）
return row.content ? editorPlainText(row.content) : '';   // 这一章没有正文 = 合法底稿
```

不加这一条，F1 就把"读失败"当成"正文没变"放行；加了之后，五个调用点（`openLastReview`、
`finalizeHarnessOutput` 两条、`runArticleReview`、`mergeReviewDiff`）全部已有 try/catch 兜住，
行为要么是"如实告知取不到"，要么是"保守拒绝"。

## 4. 新增回归门禁（`frontend-test.mjs`，107m–107q）

> ⚠️ 下表的期望值已被同日《review-merge-force-20261006》改写：现在 **107n/107o/107p 也要求"必须合并"**
> （只保留"如实告知 + 留痕"）。这里保留当时的写法，作为"第一轮修复"的历史记录。

| 断言 | 钉住的事（第一轮，已被取代） |
| --- | --- |
| `107m` | 空正文（`<p><br></p>`）+ 空基线 → **合并必须写入正文**（本次报障的复现与转绿） |
| `107n` | 空基线之后作者自己写了正文 → 当时要求拒绝（**已改为必须合并**） |
| `107o` | 预览后正文被清空 → 当时要求拒绝（**已改为必须合并**） |
| `107p` | 读不到这一章正文 → 当时要求拒绝（**已改为必须合并**） |
| `107q` | `revisionBaseArticle` 区分「读不到」（抛错）与「空正文」（返回空串）——**仍然有效** |

**变异测试（证明新门禁不是假绿，实测）**：

1. 把闸门改回旧判据（加回 `!String(current).trim()`）→ `444 PASS / 0 FAIL` 变
   `443 PASS / 1 FAIL`，唯一红的就是 `107m`（报障形状精确复现）。
2. 把 `revisionBaseArticle` 改回 `return row && row.content ? … : ''`（不抛错）→
   `442 PASS / 2 FAIL`：`107p`（读不到被当成"正文没变"放行）、`107q`。
3. 两次变异后均按原样还原，复跑 `node frontend-test.mjs` → **444 PASS / 0 FAIL**。

## 5. 复算证据（只读，零计费）

```powershell
# ch119 的正文时间线：13:27:00 起正文就是空的（manual 版本行只记录"被替换掉的那一版"）
node .p1-baseline/probe-merge-fingerprint-20261006.mjs
node .p1-baseline/probe-merge-fingerprint-2-20261006.mjs
node .p1-baseline/probe-merge-fingerprint-3-20261006.mjs
```

关键读数（活库 `data/novel.db`，只读打开）：

- `chapter_save_versions` for 119：`id 79`（13:49:15，manual）内容是 `<p><br></p>` ⇒
  **13:49:15 之前正文就是空的**；`id 77`（13:27:00，manual）与 `id 79` 之间**没有任何 manual 行**
  （`id 78` 是 `kind='draft'` 的成文草稿，不是正文写入）⇒ 审稿（13:43:16）与点合并
  （≈13:46–13:47）时正文都是 `<p><br></p>`；
- `app_logs`：`review:applied` 13:43:16、`revision:applied` 13:45:51（第 119 章，草稿链）；
- `adoption_operations`：**最新一条是 2026-10-01** ⇒ 这次（以及之后的重试）都没有成功采纳过；
- `app_logs` 13:49:15 `edit_distance_measured`（draft 4348 / final 6074）+
  `chapter_save_versions id 79` ⇒ 作者是**手工**把修稿抄进编辑器保存的；
- `harness_jobs` 里 13:41:48 的成文产出以 `kind='draft'` 落草稿（`chapter_save_versions id 78`），
  **正文从未被这次成文写过** —— 与"草稿链 + 空正文"完全吻合。

## 6. 回归执行情况（本轮实跑）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 前端执行验证 | `node frontend-test.mjs` | **444 PASS / 0 FAIL**（含新增 107m–107q） |
| Host Contract 契约 | `node .p1-baseline/test-host-contract.mjs` | **28 通过 / 0 失败 / 0 跳过**（含"前端不得自行拼装上下文"静态断言） |
| 语法 | `node --check public/app.js` / `frontend-test.mjs` | 通过 |
| 离线全量清单 / 隔离 API 套件 | `node scripts/ci-offline-checks.mjs`、`node scripts/ci-isolated-run.mjs …` | **本轮未能执行**：这两条都靠 `spawnSync(..., stdio:'pipe')` 驱动子进程，在本机沙箱下必然 `EPERM`（实测：`spawnSync node -e … → EPERM`），50 条全红是环境限制而非代码结论。已按同一清单**直接单跑**与本次改动相关的项（上两行）；本次改动**不涉及 server.js / db.js**，API 套件与迁移/契约类检查不受影响。 |

## 7. 回滚

改动前快照：`data/backup-review-merge-empty-20261006/`
（`app.js.before`、`frontend-test.mjs.before`、`SHA256SUMS.txt`、改动前的未提交 diff 统计）。
回滚 = 用这两个 `.before` 逐字节还原对应文件；本次修复**不涉及数据库结构或数据迁移**，
也不改任何 prompt / 模型路由 / 预算 / 注入字节。

## 8. 有意**未做**的事

1. **没有改差异预览的展示口径**：本轮报障里，预览把较长的相邻区块并排成"大片绿/红"是
   `diffParagraphs` 按 `\n{2,}` 分段、而草稿段落以单换行分隔造成的**显示**差异，
   与"合并被拒"是两件事。改它属于审稿链的展示层改动，影响面比本次修复大得多，留待作者裁决。
2. ~~**没有放宽"正文被改过就拒绝"这条闸门本身**~~ → **已作废**：同日作者裁决"只要是用户执行就直接强制合并"，
   这条闸门**整体取消**（覆盖前那一版由服务端在采纳事务里存进历史版本，覆盖可回退）。
   现行契约见 [`docs/review-merge-force-20261006.md`](./review-merge-force-20261006.md)。
3. **没有 bump 版号、没有改 README/CHANGELOG**（发布动作）。
