# rollback.md —— 逐文件撤销（保留作者作品与历史数据）

> 边界（任务书 §3 / §10）：**不使用** `git reset --hard`、**不删除** `data/`、**不动**作者作品与历史版本。
> 本次改动**没有** commit / push / stash，因此回滚 = 按文件还原到会话开始前的状态。

## 0. 会话开始前的基线

```text
HEAD = 6f9a14b0d1f7e11117b68d0536aee5ca238969cd   （本会话结束时**未变**）
branch = Experimental-Version-v1.0
未提交修改（会话开始前就存在，属上一轮《修复.md》成果）：
  .p1-baseline/verify-phase-map.mjs
  docs/narrative-repair/e07-run-manifest.json
  frontend-test.mjs
  package.json
  public/app.js
  public/patch-safety.js
  public/revision-patch.js
  public/revision-plan.js
  scripts/test-narrative-repair.mjs
  tests/narrative-repair/05-revision-plan.test.mjs
未跟踪（会话开始前就存在）：
  .narrative-repair-116/  docs/narrative-repair-116/  scripts/run-narrative-repair-116.mjs
  tests/narrative-repair/08-authorization.test.mjs  09-..  10-..
  tests/narrative-repair/fixtures/new-3751-spring/  修复.md  修改方案.md
```

⚠️ 上述文件里有一部分已被**上一轮**改过。**本轮的增量**只涉及下面这张表；
若要把"上一轮"也一并撤销，须另按上一轮的 rollback 说明处理（本文件不覆盖它）。

## 1. 先建立恢复边界（建议在任何回滚前执行一次）

```powershell
cd C:\Users\a1941\Desktop\DeepSeek\novel-studio
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$snap  = ".\".trim() + ".rollback-$stamp"
New-Item -ItemType Directory -Force -Path $snap | Out-Null
foreach ($f in @(
  'public/app.js','public/revision-patch.js','ai/editing/narrative-scan.mjs',
  'ai/editing/narrative-review.mjs','server.js','frontend-test.mjs',
  'scripts/test-narrative-repair.mjs','tests/narrative-repair/11-review-closure.test.mjs'
)) { if (Test-Path $f) { Copy-Item $f (Join-Path $snap (Split-Path $f -Leaf)) -Force } }
git diff > (Join-Path $snap 'working-tree.diff')
git status --porcelain=v1 > (Join-Path $snap 'status.txt')
```

这留下：每个被触达文件的副本 + 整棵工作树的 diff + 状态清单。**不删任何数据、不改任何正文。**

## 2. 本轮逐文件撤销

| 文件 | 撤销方式 | 说明 |
|---|---|---|
| `public/app.js` | 用恢复边界副本覆盖，或 `git diff public/app.js > x.diff` 后手工反转本轮三处 | 本轮增量：①红线扫描提示词块（`~10980-10990`）②`reportConsistencyHtml` + 调用（`~11182-11202`）③差异预览 `lengthInfo`/`lengthHintHtml`（`~12442-12477`）④`showReviewDiff` 形参新增 `targetWords` |
| `public/revision-patch.js` | 同上；或删掉 `AUTHORIZATION_REQUIRED` 与 `:1414-1427` 的守卫 | 本轮增量：错误码 1 行 + fail-closed 守护块 |
| `ai/editing/narrative-scan.mjs` | 同上 | 本轮增量：`DIAGNOSTICS`/`PERCEPTION_DIAGNOSTICS`、`DIAGNOSTIC_META` 两条、`SENTENCE_RE`…两个判据函数、入口处的两处 `for (const sig of …) pushCandidate`、版本号 `1.1.0 → 1.0.0` |
| `ai/editing/narrative-review.mjs` | 同上 | 本轮增量：`ABSOLUTE_CLAIM`/`EXPLANATION_RE`/`STOP`/`topicGrams`/`sharesTopic`/`explanationExample`/`checkReportConsistency`、`withConsistency` 与三处 `return withConsistency({…})` |
| `server.js` | 同上 | 本轮增量：审稿保存响应里 2 行（`consistency` / `consistency_conflicts`） |
| `frontend-test.mjs` | 删掉 `S01-a`/`S01-b`/`S01-c` 三条 | ⚠️ 该文件在会话开始前**已被上一轮改过**，勿整文件还原到 HEAD |
| `scripts/test-narrative-repair.mjs` | 删掉清单一行的 `11-review-closure` + 同进程回退块 | ⚠️ 同上，会话开始前已有改动 |
| `tests/narrative-repair/11-review-closure.test.mjs` | 直接删除（本轮新增文件） | — |
| `docs/review-closure-116/` | 直接删除（本轮新增目录） | 与上一轮的 `docs/narrative-repair-116/` **互不影响** |
| `.narrative-repair-116/probe-*.mjs`、`closure-final-suites.log` | 直接删除（本轮新增的探针与日志） | 探针不入 CI |

**不需要**迁移回滚：本轮**没有**改任何 DB schema。`chapter_reviews.report_json` 只是多了一个
`consistency` 键；去掉代码后旧行仍可读（多余键被忽略）。

## 3. 绝不能做的回滚动作

```text
❌ git reset --hard         # 会连同作者/上一轮的未提交成果一起丢掉
❌ git clean -fd            # 会删掉 data/ 之外也可能删掉上一轮的产物
❌ git stash                # 会把多个任务的改动混在一起
❌ 删除或重建 data/         # 真实作品库、历史版本、密钥都在里面
❌ 直接改真实章节正文来"还原"
```

## 4. 回滚后的验证

```powershell
node tests/narrative-repair/11-review-closure.test.mjs   # 应当不存在（已删）
node scripts/test-narrative-repair.mjs                   # 应当回到 10 个套件 / 208 条断言
node frontend-test.mjs                                   # 应当 ALL PASS（无 S01-a/b/c 三条）
```

## 5. 作者作品与历史数据的保护（与回滚无关，但必须说明）

- 本轮**没有**写入任何章节正文、角色卡或世界观实体。
- 作者的手工编辑、明确采纳、正常保存与版本历史**未被触碰**：本轮改动全在提示词、判据、
  计划/执行器的校验逻辑与展示层，不产生任何自动写库动作。
- 若要验证"作者的正文没被动过"：`git status` 中**不出现** `data/` 条目（见 `baseline.json.not_touched`）。
