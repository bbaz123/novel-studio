# A3 专项审计：前端编辑器 / AI 修改安全 / AI UX / 安全 / 大型项目性能

- 被审计仓库：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`
- 基线：分支 `refactor/p0-p6`，HEAD `565a30a79f0d0cc7b8aeceac639d13ce9a01be8a`
- 审计时工作区状态：HEAD 之上有**未提交改动**（`M public/app.js`、`M server.js`、`M frontend-test.mjs`、`M harness-plugins/novel-writing/novel-tools.mjs` 等 12 个文件）。本文所有行号与引用均针对**当前工作区文件内容**（即实际运行的那一版），不是 HEAD 快照。
- 平台：Windows，Node v24.19.0；无 ripgrep，使用 DSH grep 工具与 PowerShell `Select-String`
- 纪律：全程只读。除本文件外未创建/修改/删除被审计仓库中的任何文件；未读取 `data/`、`.verify-*`、`.test-data-*`、`*.db`、`.env`；未运行 `npm install`；未执行任何 `git add/commit/checkout/stash`。

## 0. 规模事实（先校准描述）

| 文件 | 行数（非空行 / 总行） | 字节 |
| --- | --- | --- |
| `public/app.js` | 12832 / 13651 | 779 KB |
| `public/index.html` | 70 / 70 | 4.7 KB |
| `public/styles.css` | — / 1568 | 55 KB |
| `public/long-text.js` | 435 / 450 | 22 KB |
| `server.js` | — / 8895 | 516 KB |
| `logger.js` | — / 600 | 23 KB |
| `debug-trace.js` | — / 1235 | 50 KB |
| `zip-reader.mjs` | — / 91 | 4.7 KB |
| `frontend-test.mjs` | — / 4008 | 285 KB |
| `harness-plugins/novel-writing/novel-tools.mjs` | — / 1323 | 96 KB |

前端是**零依赖原生 SPA**：`index.html` 只有骨架（侧栏 + 顶栏 + `#content` + 4 个挂载点），全部视图由 `app.js` 用模板字符串写进 `innerHTML`。没有 React/Vue，因此不存在 `dangerouslySetInnerHTML`。

---

## 1. 模块地图

```
public/index.html            70 行：骨架 + 主题内联引导脚本 + 4 个挂载点（modal/command-palette/toast/tooltip）
  └─ app.js
       ├─ 状态与传输        state(80-200) / api(229) / esc(360) / sanitizeEditorHtml(375)
       ├─ 视图分发          renderView(1044) → renderWorks(2319) / renderWriting(2918) / renderOutline(2896)
       │                    / renderTerms(4083) / renderCharacters(4146) / renderST(5638) / renderLogs(1270)
       │                    / renderTrace(2183) / renderLibrary(10067) / renderAI(6367) / renderAICreate(6480)
       ├─ 编辑器核心        renderWriting(2918) bindEditorEvents(3030) scheduleSave(3383) flushSave(3408)
       │                    saveChapterSnapshot(3564) resolveEditorConflict(3617) manualSaveChapter(3675)
       │                    openSaveHistory(3701) restoreSaveVersion(3745) previewChapterDraft(3766)
       │                    applyInlineFormat(12240) applyBlockFormat(12257)
       ├─ AI 修改安全       showAIApplyPreview(8035) applyAIReply(8069) applyAIWritingArticle(10310)
       │                    showReviewDiff(9814) mergeReviewDiff(9858) refineByChecklist(9518)
       │                    applyRevisionPatches(9716) showAIWritingResult(9133) finalizeHarnessOutput(3966)
       ├─ AI 通道           runHarnessJob(6662) pollHarnessJob(6698) runHarnessFromMessages(6775)
       │                    directAIWrite(6859) streamAIDirectWrite(6958) longTextRunTask(8291)
       ├─ 长正文分段        longTextEngine(8088) → public/long-text.js（纯函数，浏览器/Node 共用）
       ├─ 事件接线          document click×5 / input×2 / keydown×1（12281 起，全部委托）
       └─ 无框架路由        state.view + sessionStorage 持久化(1142/1162)

server.js（8895 行）
  ├─ 守卫层  isLocalRequest(338) requireAuthorChannel(195) guardAgentWrite(204) isAgentRequest(188)
  ├─ 静态    serveStatic(8734)  + 请求入口 http.createServer(8828)
  ├─ CRUD    RESOURCE_CONFIG(776) 通用 CRUD(8604-8714)
  ├─ 采纳    /api/novel/adopt(6564) 事务 + 幂等键 + 基线 hash
  ├─ 长文写入 /api/novel/chapter_save(8161)  /api/chapter_versions(8469)
  └─ AI      callAI(1115) /ai/write(?) /ai/write_stream(?) chatCompletionsUrl(1036)

logger.js       日志落盘/落库，safeStringify(72)，无脱敏
debug-trace.js  形状摘要（不落正文）shapeOf(161) messages 特例(204)
zip-reader.mjs  ZIP/EPUB 只读解析，条目策略单点在 ai/import/guard.mjs
harness.js      spawn(process.execPath, ...) shell:false(851) 子进程环境 harnessChildEnv(848)
```

---

## 2. 逐条发现

### A3-01 分段长正文任务无法整体取消；点「停止」只让当前片失败并继续跑下一片
- 可信度：**已确认**（静态 + 调用链完整可读）
- 证据：
  - `public/app.js:8155` `function longTextCancelRun() { if (state.longTextCancel) state.longTextCancel.cancelled = true; }` —— 全文件 grep `longTextCancelRun` 只有定义（8155）与 `state.longTextCancel = signal`（8333）两处，**没有任何调用点**，也没有 `data-action="long-text-cancel"`。
  - `public/app.js:8332` `const signal = { cancelled: false }; state.longTextCancel = signal;` 后交给 `K.runSegmentedTask({ plan, results, signal, ... })`（8336-8337）。
  - `public/long-text.js:348` `if (cancelled()) return { results: out, cancelled: true };` 只在**片间**检查；而 351-368 的逐片 `try/catch` 对**任何**异常一律 `rec = { status: 'failed', ... }` 并继续循环——没有 `if (e.cancelled) break`。
  - `public/app.js:8264` 每片走 `runHarnessJob`，其内部 `pollHarnessJob` 会 `progress.setCancel(...)`（6707）装上一个「停止」按钮；点它 → `cancelledErr()`（6701）抛出 → 抛到 8342-8349 的 runner → 被 `long-text.js:362` 的 catch 吞成「本片失败」→ 循环进入下一片。
- 为什么是问题：用户能看到的唯一取消控件，实际语义是「跳过这一片」，而不是「停止这次任务」。润色/扩写/整章修稿/审稿在超长章节上会切成 N 片（`DEFAULTS.max_segment_chars = 8000`，`long-text.js:29`），每片都是一次慢通道任务（分钟级 + 计费）。作者以为按下了刹车，实际车还在开。
- 用户影响：浪费数倍时间与模型费用；且「已取消」的 toast（`app.js:11132`、11210）会误导作者以为任务停了。
- 根因：取消通道只在两个「单任务」路径（`pollHarnessJob`、`streamAIDirectWrite`）接线；分段编排层（`longTextRunTask`）拿到了 `signal` 却没有把 `setCancel` 接上去，`longTextCancelRun` 成为孤儿函数。
- 建议方向：在 `longTextRunTask` 里 `progress.setCancel(() => { longTextCancelRun(); api('/harness/cancel', ...) })`；并在 `long-text.js` 的 runner catch 中透传 `e.cancelled` 提前返回 `{ cancelled: true }`。

### A3-02 编辑器自动保存不产生任何历史版本：误删正文在 800ms 后即不可恢复
- 可信度：**已确认**
- 证据：
  - `public/app.js:3392` `state.editorSaveTimer = setTimeout(() => { ... saveChapterSnapshot(snap); }, 800);` —— 每次输入后 800ms 落盘。
  - `public/app.js:3575` `const updated = await api('/chapters/${id}', { method: 'PUT', body });`
  - `server.js:8661-8701` PUT 分支：`updateRow(resource, id, body)` + `afterTemporalContentSave(...)`，**没有** `saveChapterVersion(...)`。全文件 grep：`saveChapterVersion(` 只出现在 6677（`/novel/adopt`）、8120/8134（草稿）、8192（`/novel/chapter_save`）、8480/8492（`/chapter_versions`）——**编辑器 PUT 不在其中**。
- 为什么是问题：作者在正文里 Ctrl+A 后误输入、或粘贴覆盖、或误删一大段，800ms 后脏内容直接进库；此时唯一恢复手段是浏览器原生 Ctrl+Z，而它只在**当前 DOM 没被替换过**时有效——任何一次切章、切视图、`render()`、`editor.innerHTML = ...`（冲突解决 3629、AI 应用 10364/10374/10384）都会清空浏览器的 undo 栈。
- 用户影响：正文（作品本体）不可逆丢失。对比之下 AI 相关路径（A3-04 提到）全部有版本兜底，唯独「作者自己的手」没有。
- 根因：历史版本只在「显式保存」语义的通道里创建，自动保存被当成纯持久化。
- 建议方向：PUT 时若 `content !== old.content` 且距上一版本超过 N 秒/变化率超阈值，则顺手 `saveChapterVersion(...)`（或引入「自动快照」kind，与现有 `chapter_save_versions` 的 `manual/draft` 分区并列，`server.js:1509-1519` 已支持 kind 参数与 `pruneChapterVersions`）。

### A3-03 AI 采纳（insert / append / replace）不传并发基线，服务端基线的闸门被绕过
- 可信度：**已确认**（前端未传字段 + 服务端字段存在且被使用，两处都读过）
- 证据：
  - `public/app.js:10338-10348` `/novel/adopt` body 只有 `work_id / chapter_id / content / legacy_proposal_ids / operation_key / adopt_kind`——**没有 `expected`**。
  - `server.js:6642` `if (contentProvided && chapterId && expected.content_hash && expected.content_hash !== contentHashBefore) throw new Error('本章正文在确认之后被修改过…')` —— 因为 `expected.content_hash` 为空串，这个判断**永不成立**（`server.js:6593` `expected.content_hash: asString(expected.content_hash, '')`）。
  - 对照组：审稿合并路径 `mergeReviewDiff`（`app.js:9869-9877`）在客户端做了 `textFingerprint` 比对，**但没有**回退到服务端能力；`restoreChapterDraft`（3792）走 `/novel/chapter_save`，同样无基线校验。
- 为什么是问题：作者开两个标签页（或一个窗口 + 一次 AI 采纳）时，后提交的采纳会静默覆盖另一处刚保存的正文。服务端本来具备拒绝能力，只是调用方没给参数。
- 用户影响：并发编辑互相覆盖。**不是不可逆**——`/novel/adopt` 在同一事务里把旧稿写进历史版本（`server.js:6677` `const v = saveChapterVersion(chapterId, freshChapter.title, freshChapter.summary, freshChapter.content);`），作者可从「🕘 历史版本」取回。因此定级 P1 而非 P0。
- 根因：服务端/客户端职责在两次迭代中没对齐：服务端加了 `expected.*` 契约（R02.3/R03），前端只在审稿合并这一条新路径上用了客户端指纹，老路径（AI 写作采纳）没跟上。
- 建议方向：`applyAIWritingArticle` 与 `mergeReviewDiff` 都带上 `expected.content_hash`（值取 `/chapters/:id` 的当前正文 hash 或客户端指纹的服务端口径），失败时按 409 提示「另一处已修改」。

### A3-04 模型侧直接写事件账本的通道不在审批边界内
- 可信度：**高可信静态推断**（分支与常量逐一读过；未做「无 PROPOSE_MODE 的 dsh 子进程真实写库」的活体验证）
- 证据：
  - `server.js:7837-7867` `POST /api/novel/events`：只有 `if (body.proposed === true)` 才落提案，否则 7864 `const result = addStoryEvent(workId, fields);` 直接入账。该分支**没有** `guardAgentWrite(...)`，`novel` 也不在 `authorOnlyHostMutation` 白名单里（`server.js:4835-4841`）。
  - 对照：`chapter_save`（8171）、`proposal_apply`（7920）、`state_proposal_apply`（6337）都有 `guardAgentWrite`。
  - `harness-plugins/novel-writing/novel-tools.mjs:521` `proposed: proposeMode()`，而 `proposeMode()`（第 53 行）读 `NOVELSTUDIO_PROPOSE_MODE === '1'`。
  - 全仓库只有一处注入该变量：`server.js:8291` `NOVELSTUDIO_PROPOSE_MODE: '1'`，位于 `POST /api/harness/run`。`POST /api/harness/job`（8238-8281，`generate_novel` / `compress`）不注入。
  - 子进程身份令牌确实会传给 dsh：`server.js:181-182` 设置 `process.env.NOVELSTUDIO_AGENT_TOKEN`，`ai/harness-env.mjs:99` `...base` 会把它带进子进程。
- 为什么是问题：`server.js:173-177` 自己写明的纪律是「dsh 插件工具（模型侧）→ 写入必须引用一条作者创建的、仍有效的审批」。`novel_event_add` 在 `proposeMode() === false` 时直接落库，与这条纪律矛盾；且「是不是提案模式」由**插件端环境变量**决定，不是服务端根据请求通道裁决——服务端本来有能力（`isAgentRequest`）却没有在这里用。
- 触发条件：任何未注入 `NOVELSTUDIO_PROPOSE_MODE=1` 的 dsh 进程（走 `/api/harness/job` 的命名任务；或用户按 README 把插件装进自己的 dsh profile 后直接命令行运行）调用 `novel_event_add`（模型自选工具）并显式给 `work_id`。
- 影响：事件账本被未经作者确认的内容污染（不是正文覆盖），且**审计上不可见**（没有 proposal 记录）。
- 修复方案：把 propose 判断移到服务端——`/api/novel/events`、`/api/story_memory`、`/api/novel/foreshadows/:id/status` 在 `isAgentRequest(req)` 为真时强制走提案或强制要求 approval，不让插件自报。

### A3-05 写作台目录不渲染子章节，且 UI 无法创建子章节 —— `parent_id` 是「定义了但没接线」的半个功能
- 可信度：**已确认**
- 证据：
  - `public/app.js:2929-2948` 写作台目录只渲染 `rootsOfVolumeFn(v.id)`（2938）与 `unassigned`（2945）；而 `buildChapterIndex`（2792-2805）里 `rootsOfVolume` 只收 `!c.parent_id` 的章节（2799）。
  - 全文件 grep `parent_id`：`app.js` 只出现在 2765/2767/2768/2778/2781/2784/2785/2796/2799，**全部是读取**，没有任何写入。
  - `openChapterModal`（7649-7675）表单只有 `title / volume_id / plotline_id / summary / position`，没有父章节字段；`server.js:3986`、`4224` 插入章节时 `parent_id: null`。
  - 唯一能列出全部章节的入口是单栏布局下的 `#chapter-switcher`（`app.js:2993`，`state.editorLayout === 'single'` 才渲染），而默认布局是 `two`（`app.js:85`）。
- 为什么是问题：schema（`server.js:780` 有 `parent_id` 字段）、校验（`server.js:856` `check('chapters', data.parent_id, '父章节')`）、渲染索引（`buildChapterIndex`）三层都准备好了「父子章节」，但既没有创建入口，写作台目录也不显示层级子节点。若通过 API 直接造出子章节，它在**默认布局下的写作台里完全点不到**（大纲页的 `renderOutlineList` 递归渲染 2814-2825 反而能看到）。
- 用户影响：场景/小节（子章节）要么不能建，要么建了以后在写作台找不到。
- 修复方案：二选一——补上创建/移动子章节的 UI 并在 `treeHTML` 里递归渲染；或明确把 `parent_id` 标记为保留字段并删掉死渲染分支，避免读代码的人以为它已经接线。

### A3-06 每次按键的编辑器成本 = 2 次 `innerText` + 1 次整章 `innerHTML` 序列化
- 可信度：**已确认**（代码路径确定）；「在 500 章 / 1.5 万字单章下先崩」为**高可信静态推断**
- 证据：
  - `public/app.js:3043-3048` `editor.addEventListener('input', () => { const count = wordCount(editor.innerText || ''); ... scheduleSave(); });`
  - `public/app.js:3387-3391` `state.editorSaveSnapshot = { id, content: editor ? editor.innerHTML : '', title };` —— 在 `scheduleSave()` 里**无条件**对整个 contenteditable 做一次 HTML 序列化。
  - `public/app.js:3401` `const count = editor ? wordCount(editor.innerText || '') : 0;` —— `scheduleSave` 内部**再读一次** `innerText`。
  - `wordCount`（829-831）→ `stripHtml`（760-764）→ `document.createElement('div'); div.innerHTML = html; div.textContent`，又是一次完整解析。
- 为什么是问题：`innerText` 会强制样式与布局（reflow），`innerHTML` 会序列化整棵子树。三者都是 O(正文字符数)，且都发生在**每一次按键**上，与章节长度线性相关。1.5 万字单章下每次按键要处理 3 遍全文。
- 用户影响：长章节输入延迟/掉帧（中文输入法下尤其明显）；这是作者每天都在付的成本。
- 建议方向：计数改用增量估算或 `requestIdleCallback` 节流；`editorSaveSnapshot.content` 改为在定时器触发时（800ms 后）再序列化，而不是每次按键都序列化。

### A3-07 首屏字数统计：对每一章做一次 DOM 解析
- 可信度：**已确认**
- 证据：
  - `public/app.js:836-843` `chapterWordCount(chapter)` → `wordCount(chapter.content)`（缓存按 `content` 字符串比对）。
  - 调用点：`renderOutlineList`（2818、2841、2847 每个节点）、`renderOutlineMind`（2884）、`loadWorkMeta`（931 `rows.reduce((sum, chapter) => sum + chapterWordCount(chapter), 0)`）。
  - `loadWorkMeta` 被 `renderWorks` 对**每一部作品**调用（2336-2340，并发 3）。
- 为什么是问题：缓存只在第二次之后生效。首次打开「大纲（列表）」或「我的作品」时，会对全部章节正文做 N 次 `div.innerHTML = 全章` 解析——500 章 × 3000 字 = 150 万字 HTML 解析，且是**同步**的。
- 用户影响：大作品首屏卡住数秒。
- 建议方向：`chapters` 表增加 `word_count` 列（写入时算一次），或 `/chapters` 列表接口返回预计算字数（列表接口本就返回 `content`，见 A3-09）。

### A3-08 作品库为每部作品拉取**全部章节正文**
- 可信度：**已确认**
- 证据：`public/app.js:926` `const chapters = await api('/chapters?work_id=${id}');` → `server.js:8614-8626` `getList` → `server.js:803-804` `SELECT * FROM chapters WHERE work_id = ?`（`SELECT *`，含 `content`）。`server.js:780` 的 `chapters.fields` 明确包含 `content`。
- 为什么是问题：作品卡只需要「章节数 / 总字数 / 最近编辑章节」，却把全部正文搬进内存。代码里已经有并发限制与注释（`app.js:2334-2335`），说明作者知道这个成本，但只是限流没有降量。
- 用户影响：打开「我的作品」时把整个书库的正文下载一遍（几 MB～几十 MB）。
- 建议方向：新增轻量接口（`/chapters?fields=meta` 或 `/works/:id/stats`），或让服务端在列表查询中省略 `content`。

### A3-09 全局搜索把命中章节的**整篇正文**回传，前端只用一个 snippet
- 可信度：**已确认**
- 证据：
  - `server.js:946` `const sql = \`SELECT * FROM ${table} WHERE ${conds} ... LIMIT 200\`;`（`chapters` 分支见 992-995，`fields` 含 `substr(content,1,4000)`，但返回的是 `SELECT *` 的整行）。
  - `server.js:984` `.slice(0, 20).map((x) => x.row)` —— 20 行整章内容随响应下发。
  - 前端只消费 `c.snippet`：`public/app.js:14232` `<div class="snippet">${highlightTerms(c.snippet || stripHtml(c.summary || c.content || '').slice(0, 60), q)}</div>`。
- 为什么是问题：每次搜索（300ms 防抖，`app.js:14242`）都可能传输 20 章正文；同时服务端 `snippetAny`（966-978）对每行做 `plainText`（正则剥 HTML）（967），也是 O(命中数 × 正文长度)。
- 用户影响：搜索卡顿、流量浪费；这是纯粹的可避免开销。
- 建议方向：搜索结果行投影成 `{id,title,work_id,snippet}`，不下发 `content`。

### A3-10 大纲思维导图仍是 O(根数 × 章节数)，与写作台已修的 F-27 不一致
- 可信度：**已确认**
- 证据：`public/app.js:2858` `const children = outlineChildrenOf(root);` 在 `roots.map(...)`（2857）内部；`outlineChildrenOf`（2776-2788）每次都做 `state.chapters.filter(...)` 全量扫描。同一文件里写作台已经为此建了索引：`app.js:2790-2791` 注释「F-12/F-27：一次 O(N) 预构建章节索引…避免每节点对 state.chapters 全量 filter 造成 O(N²)」。
- 用户影响：卷/剧情线多 + 章节多时（20 卷 × 500 章 = 10^4 次遍历，且每次遍历 500 元素 = 5×10^6 次比较）导图渲染变慢。
- 建议方向：`outlineChildrenOf` 改用 `buildChapterIndex().byParent`。

### A3-11 润色 / 扩写的「预览」不是 Diff
- 可信度：**已确认**
- 证据：`public/app.js:8035-8043` `showAIApplyPreview(title, reply, onApply, metaHtml) { ... body: \`${metaHtml || ''}<div class="ai-apply-preview">${esc(reply).replace(/\n/g, '<br>')}</div>\` ... }` —— 只渲染**新文本**；调用点 `app.js:11130`（润色）、`11208`（扩写）。对照修稿路径有真正的逐段 Diff：`showReviewDiff`（9814-9840，`diff-del`/`diff-add`）。
- 为什么是问题：润色/扩写是「替换原文」的动作，作者在弹窗里看不到「哪里被改了」，只能靠记忆比对。
- 用户影响：误采纳概率上升。虽然 `applyAIReply`（8069-8074）先 `await manualSaveChapter()` 再替换、可回滚，但发现差异的成本高。
- 建议方向：润色/扩写复用 `showReviewDiff`（原文 = `sel?.text || editorPlainText(editor.innerHTML)`，新文 = `run.merged`）。

### A3-12 AI 结果弹窗不显示所用模型与实际成本
- 可信度：**已确认**
- 证据：`public/app.js:9203-9220` `showAIWritingResult` 的弹窗 body 只有候选横幅、正文、`articleLengthHint`（9063）、红线扫描、连续性预检、提案摘要；footer 只有 5 个按钮。虽然入参 `meta` 携带 `channel/model/ms` 且被写进埋点（9149-9174），但**没有渲染**。token/模型只在「运行追踪」页可见（`renderTraceDetail` 2135 `↑${n.usage.prompt_tokens} ↓${n.usage.completion_tokens} tok（${n.model || ''}…）`）。
- 用户影响：作者在付费调用点看不到这次花了多少钱/用了哪个模型；`policyModel('fast')`（`server.js:64` 的 `ai/policy.mjs`）档位切换对用户不可见。
- 建议方向：把 `meta.model`、`timing.total_ms`、`usage.prompt_tokens/completion_tokens` 渲染进弹窗头部（数据已经在手，只差展示）。

### A3-13 `#ai-insert-btn`「插入到光标处」是永久隐藏的死 UI
- 可信度：**已确认**
- 证据：
  - 渲染时就是隐藏：`public/app.js:3327` `<button class="btn small secondary" data-action="ai-insert" id="ai-insert-btn" style="display:none">插入到光标处</button>`。
  - 唯二能改变它的地方反而把它继续设为 `none`：`app.js:11270-11272`（`runAIPersonality` 之后）与 `11320-11322`（`runAIOutline` 之后），两处写法完全相同：`const insertBtn = $('#ai-insert-btn'); if (insertBtn) insertBtn.style.display = 'none';`。
  - 全文件 grep `ai-insert-btn` 只有这 3 处；没有任何 `display = ''` / `'inline'`。
  - 它的处理器 `case 'ai-insert'`（13900-13909）因此永远不可能被点击触发。
- 为什么是问题：典型「定义了但没接线」。同时 11270-11272 那两行注释意图（「生成后可插入」）与行为（确保不可见）相反，是注释与行为不一致。
- 建议方向：要么在拿到 `state.aiDraft` 后 `insertBtn.style.display = ''`，要么删掉按钮与 handler。二者选一。

### A3-14 Prompt Injection 的 DATA 围栏原语 `wrapAsData` 未被产品调用
- 可信度：**已确认**（grep 全仓 + 官方文档自述互相印证）
- 证据：
  - `ai/story-state/injection.mjs:89` `export function wrapAsData(text, { label = '', kind = 'data' } = {})`（含围栏穿透防护 91 行）。
  - `ai/story-state/index.mjs:41` `import { scanInjection, wrapAsData } from './injection.mjs';` —— 这是全仓**唯一**的 `wrapAsData` 引用；没有任何调用表达式。
  - `scanInjection` 只在两处被调用：`ai/story-state/index.mjs:133`（`label: 'story_state'`）与 `injection.mjs:151`（内部批量辅助）。也就是说章节正文/世界观词条/角色卡/作者样文进入上下文时**没有**过检测，也没有围栏。
  - 仓库自己的文档已经承认这一点：`docs/golden-novel-regression-2026-09-26.md:303` 「…world 层词条正文没有过 `scanInjection`；围栏原语 `wrapAsData` 未被产品调用」。
- 为什么是问题：威胁模型（`injection.mjs:4-8`）明确把「正文 / 长期记忆 / 角色卡 / 世界观词条 / 语义召回」都列为不可信内容，但产品只对其中一层做了检测、对任何一层都没加围栏。防御被写成了库，没有接到管线里。
- 触发条件：正文/词条里出现「忽略以上所有要求…」（模式表 39-49 已覆盖这类文本）；复制粘贴的素材、上一轮模型把自己的工具标记写回正文时同样命中。
- 影响：注入文本进入提示词后**没有任何结构性隔离**。当前的实际缓解来自写侧（`guardAgentWrite` 审批 + 导入剥标签），属于「另一条防线」，不是这一条。
- 修复方案：在 `ai/context/assembler.mjs` 装配每一层不可信内容时统一 `wrapAsData`，并对全部层跑 `scanInjection` 记入预检；按项目自己的纪律「检测到不等于丢弃」（injection.mjs:14-17）保留原内容。

### A3-15 移动端（≤720px）没有写作布局降级，默认两栏会把编辑器压到 ~100px
- 可信度：**已确认**（CSS 与 JS 默认值都读过）
- 证据：
  - `public/app.js:85` `editorLayout: localStorage.getItem('ns_editor_layout') || 'two',` —— 没有按宽度给默认值（对照：同文件 176 行 `sidebarCollapsed` **有** `window.innerWidth <= 720` 的默认分支）。
  - `public/styles.css:571` `.panel-outline { width: 260px; flex-shrink: 0; }`、`:573` `.panel-editor { flex: 1; min-width: 0; ... }`。
  - `public/styles.css:1082` 起的 `@media (max-width: 720px)` 块（已完整读过）只处理 sidebar/topbar/works-grid/page-head，**没有** `.writing-layout` / `.panel-outline` / `.panel-editor` 的任何规则。
- 为什么是问题：375px 宽的手机上，默认两栏 = 目录占 260px + 14px gap，编辑器只剩约 100px 宽。
- 用户影响：手机端写作基本不可用，除非用户自己找到「单栏」按钮。
- 建议方向：在 720px 断点里强制 `.writing-layout .panel-outline{display:none}`，或在 `editorLayout` 初始化时按宽度回落 `single`。

### A3-16 没有任何安全响应头（CSP / X-Content-Type-Options / X-Frame-Options / Referrer-Policy）
- 可信度：**已确认**
- 证据：`server.js` 全文 `writeHead(` / `setHeader(` 只有 10 处（100、457、1355、4920、5153、8743、8749、8758、8761、8864），设置的 header 只有 `Content-Type`、`Cache-Control: no-store`、`Connection: close`、`Content-Disposition`。`sendJSON`（98-107）的注释明确说「不再返回 Access-Control-Allow-Origin: *」，但没有补任何其它安全头。
- 为什么是问题：本地单用户 + 无 CORS 头确实把危害压得很低（A4 用例也 PASS），但缺 CSP 意味着**一旦**出现任何一处未转义注入（A3-14 的同类风险），浏览器毫无第二道拦截；缺 `X-Frame-Options`/`frame-ancestors` 也不能排除被同机其它页面 iframe 嵌套。
- 建议方向：至少加 `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:`（前端零依赖，`index.html` 只有一个内联主题脚本需要 nonce 或 hash）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。

### A3-17 日志层无脱敏；API 异常日志会写入完整 query string
- 可信度：**已确认**（无脱敏）；「query 里会出现秘密」为**未能证实**（当前未发现把秘密放 query 的端点）
- 证据：
  - `logger.js` 全文 grep `redact|mask|sanitiz|SECRET|Bearer|api_?key|token` —— **0 命中**。`safeStringify`（72-87）只处理循环引用与长度截断。
  - `server.js:8858` `context: { method: req.method, path: pathname, query: String(req.url || '').slice(0, 500) }` —— 任何抛异常的 API 请求都会把**完整 URL（含 query）**写进日志库与日志文件；`8839` 同理。
  - `/api/logs` POST 接受任意外部条目（`harness-plugins/novel-writing/novel-tools.mjs:121` 就在用），服务端不做字段白名单。
- 为什么是问题：日志会被「运行追踪 / 日志」页面整体渲染、也能被导出。一旦将来有人在 query 里放 token（`server.js` 现有端点未发现这种用法），它会永久留在 `data/logs/*`。
- 用户影响：目前仅为潜在风险 + 日志噪音；建议加一层 `redact()`（对 `api_key|token|secret|authorization` 等键名与 `sk-…`/`Bearer …` 模式做掩码），成本极低。
- 备注：链路里**没有**把提示词正文写进日志的设计——`debug-trace.js:204-210` 明确只记 `{role, chars}`，字符串超过 160 字只记长度（`SHORT_TEXT_KEEP = 160`，31 行）。这一条是本项目做得最好的隐私控制之一。

### A3-18 `SECURITY.md` 的安全模型与实际实现已有漂移
- 可信度：**已确认**
- 证据：
  - `SECURITY.md:38-39`「The HTTP server binds to `127.0.0.1` only. **There is no authentication**, because there is no remote access.」（中文 93 行同义）。
  - 实际代码有：`server.js:181` `const AGENT_CAPABILITY_TOKEN = randomBytes(32).toString('hex')`、`188-191` `isAgentRequest` 令牌比对、`195-198` `requireAuthorChannel`、`204-237` `guardAgentWrite` 一次性审批（含基线 hash 与绑定校验）。
  - `SECURITY.md` 在「属于受理范围」里举了 XSS 之外的例子，但通篇未提内容注入/XSS 面，而 `docs/code-review-report.md:288` 自己记录过「存储型 XSS…可窃取 localStorage 会话数据」。
- 为什么是问题：安全模型文档是外部报告者判断「什么算漏洞」的唯一依据；漏掉模型通道鉴权会让报告者把已实现的能力误判为缺失，也会让维护者低估已有边界。
- 建议方向：把「模型通道用每进程随机能力令牌 + 一次性作者审批，浏览器通道无鉴权（设计如此）」写进 `SECURITY.md`，并补一句 XSS/注入的受理口径。

### A3-19 隔离回归中 `B4` 断言与现行 36MB 请求体上限漂移（1 项失败）
- 可信度：**已确认**（实跑复现 + 常量对照）
- 证据：
  - 实跑输出：`FAIL  B4 超 32MB 请求体被拒绝(413或断连)  — status=400`（`node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs`，汇总 `190/195 通过, 1 失败, 4 跳过`）。
  - 用例：`api-test-suite.mjs:91` `const big = Buffer.alloc(33 * 1024 * 1024, 65);` → `34,603,008` 字节。
  - 上限：`server.js:360` `const MAX_BODY_BYTES = 36_000_000;`，且 358-359 行注释解释了为什么必须大于 24MiB 归档 base64 后的 ~32MiB。
  - 因此 `34,603,008 > 36,000,000` 为假 → 走 415 行之后的正常读取 → `JSON.parse('AAAA…')` 失败 → `INVALID_JSON` → 400（`server.js:434-437`、`8862`）。
- 为什么是问题：**不是安全漏洞**（100MB 仍会被 413 拒绝），而是测试期望值没跟着常量走；它会持续让 CI 红，掩盖真回归。
- 修复方案：用例改成 `Buffer.alloc(40 * 1024 * 1024)`，或从 `/api/import/guard`（`server.js:5127-5129` 暴露了 limits）读上限后 +1。

### A3-20 编辑器能力缺口（逐项判定，证据见下表）
见 §3 的「有/部分/无」总表。三条最值得记的：
- **无查找/替换**：`app.js` 全文 grep `查找|替换` 只命中与 AI 应用/变量替换/文案无关的注释；没有任何 `data-action` 与之对应。写作者只能依赖浏览器 Ctrl+F。
- **无拖拽排序**：grep `draggable|dragstart|dragover` **0 命中**。章节顺序只能靠 `openChapterModal`（7671）里的 `position` 数值输入，且该输入是 `type="hidden"`——**作者根本无法改序**（`<input type="hidden" name="position" value="${chapter?.position ?? state.chapters.length}">`）。
- **无多标签**：写作台一次只持有一个 `#editor-content`（`app.js:3000`，`data-chapter-id` 单值）；切换章节即整页 `render()` 重建。

### A3-21 `savePipelineToWork` 把纯文本 Markdown 直接当章节 HTML 写入
- 可信度：**已确认**
- 证据：`public/app.js:7569-7578` `await api('/chapters', { method: 'POST', body: { ..., content: chapters, position: 0 } })` —— `chapters` 是创作工作台阶段输出的**纯文本**（`getPipelineOutput('chapters')`，7535）。同一文件在 `restoreChapterDraft` 里已经为**完全相同的缺陷**加过修正与注释：`app.js:3786-3791`「⚠️ 必须转成段落 HTML 再写回（2026-10-01 实测缺陷）：草稿来自 AI 成文的**纯文本**，直接当 HTML 写进正文会让浏览器把全部换行折叠掉」。
- 为什么是问题：同一条纪律在一处修了、另一处没修。另外这条写入路径也**绕过**了 `sanitizeEditorHtml`（`app.js:375` 的白名单消毒器只在编辑器保存/版本/草稿预览处被调用）。
- 用户影响：从「🚀 创作工作台」保存的作品正文会挤成一整段。
- 修复方案：与 3791 行一致地走 `textToParagraphsHtml(chapters)`。

### A3-22 写作区无任何可访问性语义
- 可信度：**已确认**
- 证据：
  - `public/app.js` 全文 `aria-*` 仅 12 处、`role=` 仅 4 处；写作视图（2950-3021）与编辑器工具栏（2971-2995）**一个都没有**。
  - `public/app.js:3000` `<div id="editor-content" class="editor-content" contenteditable="true" data-chapter-id="${current.id}">` —— 没有 `role="textbox"`、没有 `aria-label`、没有 `aria-multiline`。
  - `public/app.js:2997` `<input id="editor-title" value="${esc(current.title)}" placeholder="章节/场景标题">` —— 只有 placeholder，没有 `<label>`/`aria-label`。
  - 已有的正面证据：`index.html:53` `aria-label="全局搜索"`、`:56` `aria-live="polite"`、命令面板 `role="option"` + `aria-selected`（`app.js:14129`）、模态与命令面板都有 Tab 焦点环（`app.js:14468-14481`）。
- 建议方向：给 `#editor-content` 加 `role="textbox" aria-multiline="true" aria-label="章节正文"`，给 `#editor-title` 加 `aria-label`；工具栏按钮加 `aria-label`（现在只靠 `title` 与可见字符）。

### A3-23 长正文候选（含正文片段）明文驻留 `localStorage`
- 可信度：**已确认**
- 证据：`public/app.js:8128-8138` `longTextSaveRun` 把 `{kind, chapter_id, source_version, results}` 写进 `localStorage`（`LONG_TEXT_STORE_KEY`，上限 400000 字符）；`results[].output` 就是模型产出的正文片段（`long-text.js:358`）。清理只在 `longTextClearRun()`（8151）——调用点仅 `refineLongTextFull` 成功分支（`app.js:11172`）。
- 用户影响：未完成/被放弃的分段任务会把半章正文留在浏览器 profile 里，没有过期时间；`restoreSession` 不涉及它，作者也不会知道它在那儿。属于「本地单用户、非加密」口径内可接受但应予说明的行为。

### A3-24 `chapter_versions` 恢复接口用裸 `BEGIN/ROLLBACK`，与全局 `withTx` 约定不一致
- 可信度：**已确认**（当前为一致性/健壮性问题，未发现现实触发条件）
- 证据：`server.js:8489-8506` `db.exec('BEGIN'); try { ... saveChapterVersion(...); prepare('UPDATE chapters SET ...').run(...); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }`；文件里其它写路径统一走 `withTx`（`server.js:241-243`，`db.js` 里用 SAVEPOINT 支持嵌套）。
- 为什么是问题：一旦这条路径将来被包进外层事务，裸 BEGIN 会抛 `cannot start a transaction within a transaction`，而 `ROLLBACK` 会连带回滚外层。
- 建议方向：改成 `withTx(() => {...})`。

---

## 3. 第 1 题逐项回答（编辑器与专业写作体验）

| 能力 | 判定 | 证据（file:line + 短引） | 说明 |
| --- | --- | --- | --- |
| 自动保存 | **有** | `app.js:3392` `state.editorSaveTimer = setTimeout(() => {... saveChapterSnapshot(snap); }, 800)` | 输入后 800ms 防抖；快照在**触发时**捕获（F-01），避免切章把内容写回旧章 |
| 保存状态提示 | **有** | `app.js:3402` `status.innerHTML = \`<span>编辑中...</span> · ${count} 字\``；`3581` `✔ 已自动保存`；`3599` `保存失败：…` | 编辑中 / 已保存 / 失败三态齐全 |
| 保存冲突处理 | **有（做得好）** | `server.js:8666` `body._if_updated_at`；`app.js:3609-3614` `保存冲突：本地内容已保留` + 「以本地为准 / 以服务端为准」；`3617-3663` `resolveEditorConflict` | 本地稿不丢、两条明确出路、决策后闸门恢复（`flushSave` 3425） |
| Undo / Redo | **部分（仅浏览器原生）** | 无自定义实现（grep `undo|redo` 只命中无关注释）；`app.js:10364/10374/10384` `editor.innerHTML = beforeHtml` 会清空原生 undo 栈 | 没有按钮、没有快捷键接管、没有服务端撤销；A3-02 说明误删不可恢复 |
| 查找 / 替换 | **无** | 全文无 `data-action` 对应；只有浏览器 Ctrl+F | 长章节内定位只能靠系统查找 |
| 专注模式 | **有** | `app.js:2962` `data-action="focus-mode"`；`12350-12353` `layout.classList.toggle('focus-mode')`；`styles.css:557-561` 隐藏目录/参考面板 + 淡化侧栏 | 只有按钮退出，Esc 不退出（次要） |
| 章节 / 分卷树 | **部分** | `app.js:2935-2948`（写作台，只渲染根章节）→ 见 A3-05 | 分卷有；子章节在写作台不可见且无法创建 |
| 拖拽排序 | **无** | grep `draggable|dragstart|dragover|drop` 0 命中；`app.js:7671` `<input type="hidden" name="position" …>` | 连手填序号的入口都是 hidden |
| 多标签（同时开多章） | **无** | `app.js:3000` 单个 `#editor-content`，`data-chapter-id` 单值 | 切章 = 整页重建（`render()`） |
| 字数统计 | **有** | `app.js:829-831` `wordCount`；`3044` 实时更新；`3581` 保存提示带字数 | 口径统一为「剥标签后的非空白字符数」 |
| 字数目标 / 进度 | **部分** | `app.js:8911` `resolveTargetWords()` 读 `chapter.target_words`；`9063-9074` `articleLengthHint` 只在 AI 结果弹窗里对比目标 | 正文视图里没有「目标 N 字 / 已写 M 字」进度显示 |
| 版本快照 | **有** | `server.js:1509-1519` `saveChapterVersion` + `pruneChapterVersions`；`1521-1529` `LIMIT 10` 手动版；`app.js:3701-3730` 历史版本弹窗；`3745-3763` 一键恢复（`backup_current: true`） | 但**只有**显式保存/AI 采纳/草稿路径会建快照（A3-02） |
| 大纲 ↔ 正文联动 | **部分** | `openChapterModal`（7669 大纲摘要 textarea）在写作页**不出现**；写作页只有章末状态面板（`app.js:3002`、`3077` `refreshChapterStatePanel`） | 摘要要在弹窗里改；「跳转到正文某处」只有章末证据跳转（`jumpToEvidence` 3135） |
| 章节间快速跳转 | **部分** | 大纲列表/目录可点开章节；单栏布局有 `#chapter-switcher`（2993）；**没有**上一章/下一章按钮，没有 Ctrl+PgUp/PgDn（`keydown` 只处理 Ctrl+S / Ctrl+K / Esc / Tab，`app.js:14466-14538`） | 顺序阅读/连续改稿的动线缺失 |

---

## 4. 第 2 题：AI 修改安全结论（含精确代码路径）

**结论：绝大多数 AI 写回路径落在「先出候选 → 预览 → 作者确认 → 原子采纳 → 旧稿进历史版本」的安全模型里；没有发现「无任何恢复手段的直接覆盖」路径。存在两处较弱的环节：并发基线未传（A3-03）与作者自身手改无版本（A3-02）。**

逐路径取证：

| 入口 | 是否直接覆盖正文 | 预览形态 | 版本兜底 | 证据 |
| --- | --- | --- | --- | --- |
| 工具栏 ✍️ AI 写作（质量优先） | 否 | 「AI 写作结果」弹窗：全文 + 篇幅提示 + 红线扫描 + 连续性预检 + 提案勾选 | `/novel/adopt` 事务内 `saveChapterVersion` | `app.js:9133-9231`、`10310-10388`；`server.js:6677` |
| 结果弹窗「插入光标处」 | 否（写入即入库，失败回滚编辑器） | 同上 | 同上 | `app.js:10358-10366`；失败分支 `10364` `editor.innerHTML = beforeHtml` |
| 结果弹窗「追加到文末」 | 否 | 同上 | 同上 | `app.js:10377-10386` |
| 结果弹窗「替换当前正文/选中」 | 否 | 同上 + `applyAIReply` 先备份 | `manualSaveChapter`（显式版本）+ adopt 版本 | `app.js:10367-10376` → `8069-8074` `await manualSaveChapter(); replaceEditorContent(...)` |
| 工具栏 ✨ 润色 / 📖 扩写 | 否 | `showAIApplyPreview`（**纯文本预览，非 Diff**，见 A3-11） | `applyAIReply` 内的 `manualSaveChapter` | `app.js:11130`、`11208`、`8035-8043`、`8069-8074` |
| 长正文分段（润色/扩写/整章修稿/审稿） | 否 —— 覆盖清单不通过时**一个字都不动** | `showLongTextIncomplete`（`app.js:8057-8066`：标题写死「未完成（正文未被改动）」） | 候选先落 `localStorage`（A3-23），源版本不匹配即判 stale | `long-text.js:239-305` `buildCoverageManifest`、`308-314` `mergeResults`；`app.js:11124-11130` |
| 审稿 → 按清单修稿 → 差异合并 | 否 | 真正的逐段 Diff（绿=新增，红=删改） | 客户端指纹闸门 + adopt 事务版本 | `app.js:9814-9856` `showReviewDiff`；`9869-9877` `textFingerprint` 比对不符即拒绝；`9882-9892` |
| 补丁式修稿 | 否 | 命中才改，定位不到进 `unresolved` 并**必须展示** | 同上 | `app.js:9646-9672` 提示词；`9716` `applyRevisionPatches`；`9849` `notes` 渲染 |
| 批量生成章节 | 否（直接写回，但走有版本的通道） | 无预览（批量场景），逐章 toast | `POST /novel/chapter_save` 事务内 `saveChapterVersion` | `app.js:11054-11057`；`server.js:8181-8198` |
| 取回生成稿草稿 | 否 | 弹窗预览 + `confirm()` | `chapter_save` 版本 | `app.js:3766-3802`；`server.js:8161-8213` |
| 生成失败 / 取消 / 断流 | 不破坏原文 | —— | 已收到的正文落草稿（≥200 字） | `app.js:7116-7126` `saveInterruptedDraft`；`streamAIDirectWrite` 把 `partialText` 挂在 error 上（`6979-6982`、`7101`） |
| 结果弹窗关闭 / 刷新页面 | 不丢 | —— | `showAIWritingResult` 先 `POST /novel/draft` 落草稿 | `app.js:9176-9179`；`refreshChapterRecovery`（1380）在编辑器顶部显示「取回」条（`recoveryBarHtml` 1342） |

**逐段接受**：有，且粒度比「逐段」更细 —— 提案（`captureProposalSelection` 9236-9242 + `/novel/proposals/apply` 或 `/novel/adopt` 的 `legacy_proposal_ids`）可逐条勾选；修稿可勾选具体问题（`refineByChecklist` 9518）；补丁式修稿逐段命中（`applyRevisionPatches`）。**不接受**的是"部分采纳半成品正文"——覆盖清单不通过时明确不提供部分采纳（`long-text.js:305` 注释「这是'整章真的处理完了'的唯一证明」），这是一个刻意的质量取舍，属于设计而非缺陷。

**可 Undo**：① 弹窗或采纳前的显式版本（`manualSaveChapter` → `POST /chapter_versions`）；② `/novel/adopt`、`/novel/chapter_save` 事务内的旧稿版本；③ 「🕘 历史版本」里一键恢复且恢复前再备份（`app.js:3746` `confirm('确定恢复该历史版本吗？当前内容会自动备份为一条新的历史记录。')`；`server.js:8491-8493` `backup_current !== false`）。三选一均可用，但**编辑器自己的自动保存没有版本**（A3-02）。

**刷新后提案是否还在**：
- 生成稿草稿 → 在（`chapter_save_versions.kind='draft'`，`server.js:1532-1547` `getLatestDraft`，前端 `refreshChapterRecovery` 重建「取回」条）。
- 长正文分段候选 → 在（`localStorage`，`longTextLoadRun` 校验 kind/chapter_id/source_version 后复用，`app.js:8141-8149`）。超出 400000 字符则**不落**并如实记日志（8133-8136）。
- harness 长任务 → 在（服务端作业设施 + `resumeHarnessJob` 接回，`app.js:3853-3903`；404 时明确告知"服务重启后已中断"，6740-6744）。
- 待采纳的入账提案 → 在（服务端 `*_proposals` 表 + `GET /novel/proposals`）。
- 分段任务**进度**（第几片完成） → 在（`longTextSaveRun` 每次 onProgress 都写）。

**生成失败会不会破坏原文**：不会。所有失败分支只写草稿或只抛错；正文写入只发生在作者点了 footer 按钮之后，且写入前有 `beforeHtml` 快照可回滚（`app.js:10334`、`10364/10374/10384`）。

**「无可靠恢复的直接覆盖」排查结论**：逐条走完 12 条写正文的路径后，未发现由 AI 触发的无恢复覆盖。唯一不可恢复的覆盖来自**作者自己的编辑器输入**（A3-02），以及 A3-03 描述的并发覆盖（有版本，可恢复）。触发入口（若按最严格口径记）：`#editor-content` 上的任意输入 → 800ms → `PUT /api/chapters/:id`。

---

## 5. 第 5 题：安全项专表

| # | 文件｜符号/行号 | 风险 | 触发条件 | 影响 | 已验证？ | 修复方案 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `server.js:7837` `POST /api/novel/events`（无 `guardAgentWrite`、无 `requireAuthorChannel`） | **中（越权写入）** | 带 `X-Novel-Agent-Token` 且未设 `NOVELSTUDIO_PROPOSE_MODE=1` 的 dsh 进程调用 `novel_event_add` | 事件账本被未经作者确认的内容污染，且无 proposal 审计痕迹 | 静态已确认；活体未验证 | 服务端按 `isAgentRequest(req)` 强制提案或强制 approval |
| S2 | `server.js:6642` + `app.js:10338-10348` 未传 `expected.content_hash` | 低-中（并发覆盖） | 两个窗口同时改同一章并采纳 AI 结果 | 后写者覆盖先写者；旧稿在历史版本里，可恢复 | 已确认（字段与调用两处都读过） | 前端补 `expected.content_hash` |
| S3 | `app.js:375` `sanitizeEditorHtml` 白名单消毒器 | ——（**正面项**，列此说明边界） | 任何进入 `#editor-content`/版本预览/草稿预览的 HTML | `SCRIPT/STYLE/IFRAME/…/IMG/SVG` 整体丢弃、`A` 只保留 `data-term-id`、属性重建 | 已确认（375-412 逐行读过；`frontend-test.mjs` 有断言） | 保持；把 `savePipelineToWork`（A3-21）也接进来 |
| S4 | `app.js` 118 处 `innerHTML` 赋值中未发现可注入点 | 低 | —— | 抽查了所有拼接用户/模型数据的模板（见 §6 清单），均走 `esc()` 或 `sanitizeEditorHtml()`/`stripHtml()` | 静态已确认（抽查 + 定向 grep 未命中模式）；未做 fuzz | 加 CSP 作为第二道防线（A3-16） |
| S5 | `server.js:8734-8745` `serveStatic` 路径穿越防护 | 低（**已正确防护**） | `GET /../..%2fpackage.json` 等 | `path.normalize` + 剥前导 `../` + `path.relative` 双检，越界回 403 | **已确认（活体验证）**：隔离实例 `A3 路径穿越被中和(不回传 package.json 内容)` PASS | 保持 |
| S6 | `zip-reader.mjs:55` `assertArchiveEntry` + `ai/import/guard.mjs` | 低（**已正确防护**） | 恶意 EPUB：`../` 条目名、symlink、zip 炸弹、超大条目 | 条目名/symlink/压缩方式/压缩比/单条与总量上限全部单点校验；失败即整包抛错（不返回半个包） | 已确认（91 行全文读过；`IMPORT_LIMITS` 由 `/api/import/guard` 暴露） | 保持 |
| S7 | `server.js:338-356` `isLocalRequest` | 中（**只挡写方法**） | 跨源 `GET` | 非 mutating 方法直接 `return true`（339 行）；跨源页面可以发起 GET，但**读不到响应**（全站无 `Access-Control-Allow-Origin`） | 已确认（活体 `A4 无 ACAO 通配/CORS 响应头` PASS） | 保持现状即可；**未穷举**所有 GET 分支是否无副作用（见 §7） |
| S8 | `server.js:188-191` + `181` agent 能力令牌 | ——（**正面项**） | 模型进程伪装成作者 | 每进程随机 32 字节令牌经 `process.env` 注入子进程（`harness-env.mjs:99` `...base`）；固定布尔头默认不构成身份（`ALLOW_LEGACY_AGENT_HEADER` 默认 false） | 已确认 | 保持；把 S1 补齐 |
| S9 | `server.js:100-105` 响应头 | 中（缺失加固） | —— | 只有 `Content-Type` + `Cache-Control: no-store`；无 CSP / nosniff / XFO / Referrer-Policy（A3-16） | 已确认（全文 10 处 header 写入点逐一读过） | 补 4 个安全头 |
| S10 | `server.js:869-875` `maskApiKey` + `8612` `maskRow` | ——（**正面项**） | 前端读取 `/api/configs` | 列表与单条都掩码；短 key 返回 `'••••••'` 而非原文（872-873 的注释明确了这个边界）；key 只经 `config_id` 在服务端使用（`app.js:6879-6890`） | 已确认 | 保持 |
| S11 | `logger.js` 全文件无脱敏 + `server.js:8858` 记录完整 query | 低-中 | API 抛异常 | 完整 URL 进日志库/文件；将来若有秘密进 query 会永久留存 | 已确认（grep 0 命中） | 加 `redact()` |
| S12 | `debug-trace.js:161-215` `shapeOf` | ——（**正面项**） | 运行追踪录制 | 字符串 >160 字只记长度；`messages` 只记 `{role, chars}`（204-210）；参数只记字段名与白名单关键值；`DEBUG_DIR` 在 `data/` 下（111） | 已确认 | 保持 |
| S13 | `harness.js:851` `spawn(process.execPath, spawnArgs, { shell: false, ...})` | ——（**正面项**） | 长任务文本进入命令行 | 全程 `shell:false`（849-850 注释点名 HA-06）；超过 Windows 32767 码元时改走 stdin（839、860-867） | 已确认 | 保持 |
| S14 | `server.js:728-745` `normalizeOvEndpoint` | ——（**正面项**） | 自定义 OpenViking 地址（SSRF 面） | 强制本机回环（`isLocalHost`），非回环直接拒绝：`server.js:742` `'OpenViking 地址只能使用本机回环地址…'`；活体 `M19`（路径形式 target 被拒）/`M23`/`M24` PASS | 已确认 | 保持 |
| S15 | `server.js:776-788` `api_configs.base_url` | 低（**设计如此**） | 作者填任意 `base_url` | 服务端会 `fetch(`${base}/chat/completions`)`（`server.js:1036-1042`、`1115+`）——这是「支持第三方 OpenAI 兼容端点」的功能本身；`isDeepSeekEndpoint`（1053-1060）只用于决定是否下发 `reasoning_effort` | 已确认 | 若要收紧：限制为 https + 禁私网段（但会破坏本地 Ollama 类用法，需与作者确认） |
| S16 | `ai/story-state/injection.mjs:89` `wrapAsData` 未被调用 | 中（注入面未接线） | 正文/词条/召回内容夹带指令 | 提示词里没有 DATA 围栏；检测也只覆盖 `story_state` 一层（A3-14） | 已确认（grep + 项目自己的文档承认） | 在上下文装配层统一围栏 + 全层扫描 |
| S17 | `public/app.js:8128-8138` 长正文候选入 `localStorage` | 低（本地数据驻留） | 分段任务未完成即离开 | 半章正文明文留在浏览器 profile，无过期时间 | 已确认 | 加 TTL 或任务结束即清 |
| S18 | AI Key 存储位置 | 低（**设计如此且已文档化**） | —— | `data/` 下 SQLite 明文；`SECURITY.md:41-43` 明确写了这是设计、靠操作系统保护；未进入前端 bundle（前端只拿到掩码） | 已确认（`app.js:6401` `API Key：${c.api_key ? '••••••' + …slice(-4) : '未填写'}`） | 保持；把 S1 的模型通道说明补进 SECURITY.md（A3-18） |
| S19 | `harness-plugins/…/novel-tools.mjs` 全文 | ——（**正面项**） | 插件持久化 | grep `api_key|token|writeFile|appendFile|Authorization|Bearer` **0 命中**；只从 `process.env` 读 base URL 与令牌，不写盘、不落日志正文（`:52`、`:67-71`、`:118-128`） | 已确认 | 保持 |
| S20 | Prompt Injection 的现实影响面 | 中 | 正文写「忽略以上全部指令…」 | 写入侧仍有防线（`guardAgentWrite` 审批 + `isAgentRequest` 通道判定），但**上下文侧无隔离**；项目自述「没有专门的注入红队用例」（`docs/enhancement-acceptance.md:224`、`docs/enhancement-audit.md:151`） | 部分证据：静态已确认；文档自述未做 live 红队 | 见 S16 |

---

## 6. 确认正常工作、不是问题的部分

1. **编辑器保存的冲突处理是一套完整状态机，不是提示语。** `_if_updated_at` 乐观锁（`server.js:8666-8670`）；409 时不覆盖本地稿（`app.js:3584-3597`）；给出「以本地为准 / 以服务端为准」两条出路（`3609-3615`）；本地方案先取最新 `updated_at` 再重试（`3644-3656`）；`flushSave` 在冲突期间明确返回 false 阻塞导航（`3409`、`3425`）；`beforeunload` 提示未保存（`14557-14562`）；回归有 6 条断言（`frontend-test.mjs:952-961`）。**已确认。**
2. **XSS 的主防线是 DOM 白名单消毒器，而不是转义约定。** `sanitizeEditorHtml`（`app.js:375-412`）用 `DOMParser` 解析后重建，丢弃 `SCRIPT/STYLE/IFRAME/OBJECT/EMBED/LINK/META/BASE/FORM/INPUT/BUTTON/TEXTAREA/SELECT/OPTION/IMG/SVG/MATH/VIDEO/AUDIO/SOURCE/TRACK/TEMPLATE`（373 行），`A` 标签只保留 `data-term-id`（385-393），白名单外标签解包保留文本（394-397，不用 `innerHTML` 拼回）。三处渲染正文的地方都调用它：`app.js:3000`（编辑器）、`3739`（历史版本预览）、`3772`（草稿预览）。`esc()`（360-367）覆盖 `& < > " '` 五个字符，模板里被一致使用。**已确认。**
3. **静态文件服务与 ZIP 解析的路径穿越防护是验证过 PASS 的。** 静态：`path.normalize` + 剥前导 `../` + `path.relative` 双检（`server.js:8739-8745`），活体 `A3 路径穿越被中和` PASS；ZIP：条目策略单点在 `ai/import/guard.mjs`（`zip-reader.mjs:55`），解压上限用 `inflateRawSync(..., { maxOutputLength })`（73），symlink 按 `versionMadeBy` + external attributes 判定（`zip-reader.mjs:8` 注释 + 41/48 行取值），条目损坏即整包抛错（39、51、61、67）。**已确认。**
4. **运行追踪（调试录制）真的不记正文。** `shapeOf` 对 >160 字的字符串只记 `{len, omitted}`（`debug-trace.js:166-168`），对 `messages` 数组特例化为 `{role, chars}`（204-210），参数只取前 6 个并按白名单取关键字段（`CRITICAL_KEYS`，128-135）；`MAX_SHAPE_KEYS = 24`、`MAX_DEPTH = 12`。前端详情视图也用 `esc(JSON.stringify(...))`（`app.js:2151`）。**已确认。**
5. **AI 写回是原子的且有幂等键。** `/novel/adopt`（`server.js:6564-6717`）：`operation_key` 长度校验（6583）、payload hash 比对拒绝同键不同内容（6600-6603）、状态提案与旧提案与正文与投影 outbox 在 `withTx` 内（6638-6708）、任一失败整体回滚并回 409（6709-6711）、幂等重放直接返回原结果（6606）。**已确认（代码逐行读过）**；`frontend-test.mjs` 全绿（PASS 计数见 §8）。
6. **长正文分段有可机械验证的覆盖证明，且不通过就不许合并。** `buildCoverageManifest`（`long-text.js:239-305`）检查缺片/重复/越界/版本不匹配/顺序/首段起点/尾段终点/章尾哨兵；`mergeResults`（308-314）只在 `manifest.ok` 时返回合并正文，否则 `merged: null`；UI 侧 `showLongTextIncomplete` 标题写死「未完成（正文未被改动）」（`app.js:8061`）。**已确认。**
7. **`shell:false` 与提示词不落盘这两条纪律在代码里是一致的。** 见 S12/S13。**已确认。**

---

## 7. 未能证实 / 尚未验证

1. **S1（模型侧直接写事件账本）的活体复现。** 我确认了「`/api/novel/events` 无审批守卫」「插件 `proposed` 取决于 env」「只有 `/harness/run` 注入该 env」三条静态事实，但**没有**真的起一个不注入 `NOVELSTUDIO_PROPOSE_MODE` 的 dsh 子进程去写库（那需要真实模型调用与真实数据）。结论按「高可信静态推断」记录。
2. **`GET` 分支是否存在副作用（CSRF 面）未穷举。** `isLocalRequest` 对非 mutating 方法直接放行（`server.js:339`），我只抽查了 export / logs / debug / harness / novel 的 GET 分支未发现 `.run(` / `INSERT` / `UPDATE`，没有做覆盖全部 GET 分支的机器化检查。**未能证实「所有 GET 都无副作用」。**
3. **A3-06 的性能影响没有实测数字。** 我确认了「每键 2×innerText + 1×innerHTML」的代码事实，但没有在 500 章 / 1.5 万字真实数据上做输入延迟测量（被审计仓库的 `data/` 是禁读区，且不允许对真实数据操作）。所有关于「哪里先崩」的判断都是**高可信静态推断**：最可能先崩的四处依序是 —— ① 打开「我的作品」时 `loadWorkMeta` 对每部作品全量拉正文 + 逐章 DOM 解析字数（A3-07/A3-08）；② 打开大纲列表时 500 次 `div.innerHTML` 解析（A3-07）；③ 写作台每次切换章节整页重建含全部章节的目录（A3-05 相关，`renderWriting` 2935-2948 + `render()` 全量替换）；④ 长章节输入时的每键三重 O(N) 成本（A3-06）。
4. **移动端真实表现未在设备/模拟器上验证。** A3-15 是基于 CSS 常量（`width:260px` + `flex-shrink:0`）与 JS 默认值（`'two'`）的推断，没有真机截图。
5. **`B4` 之外是否还有测试漂移未查。** 我只跑了被授权的两个入口；`api-test-suite.mjs` 有 195 条断言，我没有逐条对照服务端常量。此外本轮 `SKIP 4 项`（M26-M29，全局 OpenViking 配置写入）是因为目标文件在隔离目录之外、不可还原而主动跳过 —— 如实计入「未执行」。
6. **`server.js` 516KB / 8895 行没有全文精读。** 我按主题定位后精读了守卫层、静态服务、请求体、通用 CRUD、adopt、chapter_save、chapter_versions、novel/events、proposals、harness 启动、AI 直连与 base_url 处理、日志初始化等约 40 个区段；中间大量业务路由（时态引擎 / 故事状态内核 / 分支沙盘 / 共享资料库）只读了入口与守卫，未逐行审计。

---

## 8. 运行验证记录（全部在隔离环境内）

| 命令 | 结果 | 是否触碰真实数据 |
| --- | --- | --- |
| `node frontend-test.mjs` | **`=== ALL PASS ===`，退出码 0**（T7 段全 PASS，含 409 冲突恢复 P0-01a..f、长正文覆盖证明 R08、批量生成红线告知、取回生成稿段落归一化等） | 否 —— 先只读确认：全文只有 `fs.readFileSync`（第 10、924、2204、3087、3354、3412 行），无任何写文件调用 |
| `node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs` | **190/195 通过，1 失败，4 跳过**；失败项 `B4 超 32MB 请求体被拒绝(413或断连) — status=400`（见 A3-19）；跳过项 M26-M29（全局 OpenViking 配置写入，目标在隔离目录外故不执行） | 否 —— `scripts/ci-isolated-run.mjs:45` `DATA_DIR = path.resolve(arg('--data', path.join(os.tmpdir(), 'novel-studio-ci-...')))`；`:55` `NOVELSTUDIO_DATA_DIR: DATA_DIR`；`:56` `NOVELSTUDIO_OV_DISABLED: '1'`；跑完自动关实例（`:67`） |
| 隔离静态检查（随上一条输出） | `A1` 首页 200 / `A2` app.js 200 / `A3` 路径穿越被中和 / `A4` 无 ACAO 通配 / `A5-A9` API 404、非法 id、畸形百分号编码 400、SQL 报错不外泄 | 否 |
| 未执行 | 未 `npm install`、未 `git add/commit/checkout/stash`、未起常驻实例、未对真实 `data/` 做任何读写 | —— |

> 说明：三次 CI 隔离运行中有一次（`--port 3741`）实例未能就绪（退出码 2），换回文档端口 3738 后正常；上表记录的是成功那一轮。第二轮 `--port 3738` 复现了同一处 `B4 status=400`，A3-19 的结论是稳定的、不是偶发。

---

## 9. 缺陷清单（按优先级）

| 编号 | 标题 | 级别 | 可信度 |
| --- | --- | --- | --- |
| A3-01 | 分段长正文任务无法整体取消，点「停止」只让当前片失败并继续 | P1 | 已确认 |
| A3-02 | 编辑器自动保存不产生历史版本，误删正文 800ms 后不可恢复 | P1 | 已确认 |
| A3-03 | AI 采纳不传并发基线，服务端 `expected.content_hash` 闸门被绕过 | P1 | 已确认 |
| A3-04 | 模型侧写事件账本的通道不在审批边界内 | P1 | 高可信静态推断 |
| A3-05 | 写作台目录不渲染子章节且 UI 无法创建子章节（`parent_id` 半接线） | P2 | 已确认 |
| A3-06 | 每键 2×`innerText` + 1×整章 `innerHTML` 序列化 | P2 | 已确认（性能量级为静态推断） |
| A3-07 | 首屏字数统计对每章做一次 DOM 解析 | P2 | 已确认 |
| A3-08 | 作品库为每部作品拉取全部章节正文 | P2 | 已确认 |
| A3-09 | 全局搜索回传命中章节整篇正文 | P2 | 已确认 |
| A3-10 | 大纲导图仍 O(根×章)，与写作台 F-27 修复不一致 | P2 | 已确认 |
| A3-11 | 润色/扩写预览不是 Diff | P2 | 已确认 |
| A3-12 | AI 结果弹窗不显示模型与成本 | P2 | 已确认 |
| A3-13 | `#ai-insert-btn` 永久隐藏的死 UI | P2 | 已确认 |
| A3-14 | Prompt Injection 的 `wrapAsData` 围栏未被产品调用 | P2 | 已确认 |
| A3-15 | 移动端无写作布局降级 | P2 | 已确认（静态） |
| A3-16 | 无 CSP 等安全响应头 | P2 | 已确认 |
| A3-17 | 日志无脱敏；异常日志记录完整 query | P2 | 已确认（无脱敏）/ 未证实（秘密进 query） |
| A3-18 | `SECURITY.md` 安全模型与实现漂移 | P2 | 已确认 |
| A3-19 | 隔离回归 `B4` 断言与 36MB 上限漂移 | P2（测试） | 已确认 |
| A3-20 | 无查找替换 / 无拖拽排序 / 无多标签 / 无自定义 Undo / 无目标进度 / 无上下章跳转 | P3 | 已确认 |
| A3-21 | `savePipelineToWork` 纯文本当 HTML 写正文（同类缺陷已在别处修过） | P3 | 已确认 |
| A3-22 | 写作区无可访问性语义 | P3 | 已确认 |
| A3-23 | 长正文候选明文驻留 `localStorage` 且无过期 | P3 | 已确认 |
| A3-24 | `chapter_versions/restore` 用裸 BEGIN，未走 `withTx` | P3 | 已确认 |

（全文完）
