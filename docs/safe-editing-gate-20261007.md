# 第三批 · Safe Editing：修稿安全门禁（2026-10-07）

> 依据《Novel-Studio 修稿前后问题整合与 Safe-Editing 修改方案》§5 / §7 / §8 / §9 / §12 / §13 / §14 / §15(P0)。
> 裁决记录：待确认事项 C1、C2 均经 `confirmation_resolution` 判为 **MODIFY**，选中方案为
> 「新增 `public/patch-safety.js` 确定性模块并接入补丁链路；**只拦命中的高风险补丁**，其余照旧应用」。
> 本批**不改模型输出契约**（补丁 JSON 形状与提示词字段一字未动），也不改"作者点合并到正文就无拦阻"的既有裁决。

## 1. 要解决的问题

第二阶段（诊断层，见 [deai-round2-diagnostics-20261006.md](deai-round2-diagnostics-20261006.md)）已经能发现
信息饱和 / 功能重复 / 过度解释，但**补丁无论删什么都不检查**：`applyRevisionPatches` 只回答"这条补丁
能不能唯一定位"，不回答"该不该自动应用"。于是同一章真实出现了四类误伤：

| 误伤 | 形态 | 后果 |
|---|---|---|
| `object_provenance` | 删掉"王磊把面包递给岳宸炎，一个字没说"这一句 | 后文"岳宸炎吃面包"凭空出现物件 |
| `reference_anchor` | 删掉首次人物主体（"一个女生从通道走出来"） | 后文"她"没有先行语 |
| `scene_anchor` | 删掉"大屏切到海澜市" | 读者不知道在看现场还是屏幕 |
| `story_fact` | 为解释排队时间顺手新增整套 B 区错号支线 | 正式设定被风格审稿器改写 |

## 2. 落点

| 文件 | 变化 |
|---|---|
| `public/patch-safety.js` | **新增**（UMD 纯函数模块，浏览器与 Node 测试共用；`window.NovelPatchSafety`） |
| `public/index.html` | 在 `/long-text.js` 之前加载 `/patch-safety.js`（同源静态文件，CSP `script-src 'self'` 不变） |
| `public/app.js` | 门禁接入层（取参数 / 调用 / 失败姿态）+ `tryApplyRevisionOutput` 过门禁 + 差异预览新增「安全门禁」分区 |
| `frontend-test.mjs` | 桩环境按页面顺序加载新模块 + 新增 19 条断言（`94a`–`94r`） |
| `.p1-baseline/verify-phase-map.mjs` | 新增阶段条目 `SE`（本文件必须被某个阶段认领） |

## 3. 判据口径（零误报优先）

三条纪律写在模块头部常量上：① 判据只认能被逐字指出来的证据；② 未命中不表态；
③ 逐条粒度——命中的那一条不进差异稿，同批其余补丁照旧应用。

| 结论码 | 触发条件（全部可离线复算） | 硬拦 |
|---|---|---|
| `protected_content` | anchor 含作者指定的保护句、revised 里没有了（逐字子串） | ✅ |
| `story_fact` | 改后新出现**本章此前从未出现过**的正式事实形态：等级（`X级`）、地名机构、拉丁编号区（`B区`）、编号日期、新人物名；或改后段落长出一倍且多 60 字以上 | ✅ |
| `object_provenance` | 被删段落的词面在后文**以回指式用法**（`那/这/把/他她的/手里的/处置动词` + 名词）再次出现，而它在删除点之前**没有任何残留出现**，也没有被重新引入 | ✅ |
| `reference_anchor` | 被删段落含人物名或主体名词（`女生/少年/同学/…`，人物卡名字也计入），改后不再包含它；后 3 段内出现代词，且该代词之前**已无任何人称锚点** | ✅ |
| `scene_anchor` | 被删段落含场景来源词（`大屏/屏幕/画面/镜头/直播/转播/切到/…`），改后不含任何场景词，且后 3 段仍在用代词或该段的地名承接 | ✅ |
| `causal_bridge_break` | 被删段落含原因连词，后 4 段仍有结果连词承接 | ❌ 只报告 |

分级（§9）：`wording`（删掉的只是描写：无对白、无人称主体、无动作动词）与 `local_structure`
（删掉带动作/对白/主体的句子）都放行；`story_fact` 一律不自动应用。

## 4. 接线与失败姿态

- `tryApplyRevisionOutput(output, base, opts)`：解析 → 门禁 → 只把 `allowed` 交给 `applyRevisionPatches`。
  **全部被拦时返回 `ok + allBlocked`**（不是 `ok=false`）：`ok=false` 会让调用方回退整章重写——
  那是一次付费且**没有门禁**的整章覆盖，正好会重犯同一处错误。
- 分段路径（`longTextKindMeta('revision_patch')` 的 `parse`）按**本片底稿**判定，被拦条数与原因
  随 `extra` 上抛，差异预览逐条展示。
- 整章重写兜底路径（`buildAIRevisionPrompt` → `revision_full`）没有补丁可拦，改用
  `patchSafetyVerify` 做 **Diff-aware 修后核验**（只报告），核验结果同样进差异预览。
- **失败姿态是放行**：门禁模块缺失或抛错时绝不阻塞作者修稿，但会在预览里写明
  `safety_unavailable`（本次没有任何补丁被拦截）——静默降级才是真正危险的失败。

## 5. 明确不做

- 不改生成端主 Prompt、不加禁词、不按出现次数删人物专属动作、不为删总结补文学式章尾（文档 §16）。
- 不改"作者点「合并到正文」就必须写进去"（2026-10-06 作者裁决）——门禁只作用于**补丁是否进入差异稿**。
- 本批不改模型输出契约：`{"patches":[{issue,anchor,revised}]}` 与审稿 JSON 形状完全不变，
  因此**没有** `fact_delta`/`edit_scope` 自报字段，也**没有**审稿 `repair_necessity/confidence`
  （属 C2 未选中的 `P0_FULL` 批次）。`story_fact` 目前由确定性证据形态判定，不依赖模型自报。

## 6. 验收（离线、零计费）

`node frontend-test.mjs` —— 新增断言逐条对应文档 §14：

| 断言 | 对应 |
|---|---|
| `94b/94c/94c2` | Test 1 面包：`object_provenance`，且**不回退整章重写** |
| `94d/94e` | Test 2 直播女生：`scene_anchor` / `reference_anchor` |
| `94f` | Test 3 B 区：`story_fact`（禁止自动应用） |
| `94g` | Test 4 李拓 A 级：放行 + `wording` |
| `94h` | Test 5 章尾总结：放行 |
| `94i/94j` | 阴性对照：同功能压缩、先行语仍在前文的名字→代词，零误报 |
| `94k` | 逐条粒度：同批一拦一放，`blocked=1 / applied=1` |
| `94l/94m` | Diff-aware 修后核验（整章重写路径）能发现断裂、且不误报 |
| `94n/94o` | `protected_content` 命中即拦、逐字保留即放行 |
| `94p` | 门禁不可用时放行但产出可见提示 |
| `94q/94r` | 差异预览渲染安全分区；零命中时不渲染 |

`public/app.js` 旧行为未变：`87/88/89/90/90a/90b/90c/58ad`（补丁定位、空补丁 = 合法无修改、
唯一性/重叠拒绝、单请求归属）全部保持通过。

## 7. 已知边界与后续（未做，明确记录）

1. 门禁是**文本判据**，不做语义理解：它拦"后文真的还在用这个东西"的删除，不拦"读者会觉得这里少了什么"。
2. `protected_content` 目前只从 `localStorage`（`ns_protected_content:<workId>[:<chapterId>]`，JSON 字符串数组）
   读取，**没有界面入口**；保护句的完整界面（可编辑、按章保存）是下一批的事。
3. `fact_delta` 数值化（Level 0–3 由模型自报）与审稿 `repair_necessity/confidence` 决策表属 **C2 未选中批次**。
4. `causal_bridge_break` 只报告不拦：`因为/为了` 太常见，硬拦会误伤正常压缩。

## 8. 回滚

- `public/patch-safety.js` 与本文档可整体删除；
- `public/app.js` 的接入是少数几处（接入层函数、`tryApplyRevisionOutput`、`showReviewDiff` 的
  `blocked/findings` 参数与 4 个 `showReviewDiff` 调用点、分段 `parse` 的 `extra`）；
- `public/index.html` 删掉一行 script 即回到旧行为；`frontend-test.mjs` 删掉 9b 节与加载行即可。

`app.js` / `frontend-test.mjs` 与其它阶段共享同一文件，按文件粒度只能整体回滚，故阶段映射里
`rollback = shared`（新模块与文档本身可独立撤回）。
