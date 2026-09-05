# Novel Studio × dsh 创作内核（ENGINE）

本文记录创作内核的当前实现：dsh 在小说生成时**自动尊重世界观/角色卡/长期记忆/未闭合伏笔**，
按“反 AI 腔”风格契约输出，生成后自动收尾（一致性核对 → 红线扫描 → 事件/记忆**提案** → 作者确认入账）。
本插件是 novel-studio 的内置组件，**与工坊同仓维护**，不存在独立补丁仓库漂移问题。

## 一、架构（两层）

```
novel-studio（数据真相源）
  ├─ 数据表：story_events（伏笔状态/回收/去重）、memory_versions（记忆快照/回滚）、
  │          writing_redlines（红线）、story_event_proposals / story_memory_proposals（入账提案）、
  │          works.*（每章目标字数/总章数/故事结构/叙事视角）、chapters.blueprint_json / target_words
  ├─ 创作内核：buildNovelContext（ST 式分层装配 + 分层预算 + 蓝图层 + 目标字数）、
  │          scanAgainstRedlines（含对话豁免）、saveStoryMemory（版本快照 + 保留策略 + 压缩提示）、
  │          提案确认（apply/reject）、多关键词加权检索
  ├─ 端点：/api/novel/*、/api/story_memory 版本与回滚、/api/novel/proposals、/api/search
  └─ /api/harness/run：注入 NOVELSTUDIO_WORK_ID/CHAPTER_ID/MODE + NOVELSTUDIO_PROPOSE_MODE=1
        │ spawn（携带身份 env）
        ▼
dsh headless / dsh 会话（工具与人设同源：harness-plugins/novel-writing/）
  ├─（确定性层）上下文/蓝图/目标字数/红线在 prompt 侧已装配 → 生成即守设定、不 AI 腔
  ├─（agent 层）novel_* 工具：上下文按需拉取、设定查证、伏笔闭环、蓝图保存、一致性核对、
  │   产出自检、事件/记忆提案（headless）或直接入账（GUI）、正文写回
  └─（收尾层）红线扫描结果随 /harness/run 响应返回；事件/记忆提案由作者在界面确认
```

## 二、关键机制

### 1. 提案确认（headless 防污染）

- `/api/harness/run` 给子进程注入 `NOVELSTUDIO_PROPOSE_MODE=1`；
- dsh 工具检测到该环境变量后，`novel_event_add` / `novel_memory_update` 改为
  `POST /api/novel/events {proposed:true}` / `PUT /api/story_memory {proposed:true}`，
  写入 `story_event_proposals` / `story_memory_proposals`（status=pending），**不触碰真实账本**；
- 任务完成时 `GET /harness/job` 的 `proposals` 字段带回全部 pending 提案；
- 作者在「AI 写作结果」弹窗勾选采纳（随正文应用一起生效），或稍后在
  「小说设定 → 长期记忆 → 📥 待确认提案」逐条采纳/忽略；
- 采纳事件提案 = 正式 `addStoryEvent`（含伏笔回收与 dedup 幂等）；采纳记忆提案 = `saveStoryMemory`（留版本快照）。

### 2. 伏笔闭环

- `story_events` 增加 `foreshadow_status`（''/open、resolved、dropped）与 `resolves_event_id`；
- 新埋伏笔：`kind=foreshadow`（默认 open）；回收：`kind=event` + `resolves_event_id=#伏笔id`，
  服务端自动把该伏笔置 resolved；
- `novel_context` 的【未闭合伏笔】层与 `novel_foreshadows`、`novel_consistency` 共用这一状态。

### 3. 分层上下文预算

`buildNovelContext` 每层独立上限（作品 900 / 大纲 2800 / 记忆 2200 / 事件 1800 / 伏笔 1200 /
场景 1200 / **蓝图 1500** / 前文衔接 1600–4000 / 角色卡 4000 / 关系 800 / 世界观 3000 / 红线 4000），
整块结果再按 26000 字总预算收敛（弹性层依次收缩，红线层不动）；
记忆超过 1200 字压缩提示线时在上下文里标注，提醒模型优先压缩。

### 3b. 章节蓝图与目标字数（写前规划 → 落库 → 常驻锚点）

- 蓝图字段：`scene_goal`（场景目标）/ `plot_points`（情节点 3-8 条）/ `conflicts`（冲突与转折）/
  `character_changes`（出场角色状态变化）/ `hook`（下一章钩子）/ `references`（需回扣的设定/伏笔）；
- 工坊内 AI 写作流程：澄清需求 → 模型输出【蓝图】JSON → 弹窗可编辑确认 → `PUT /api/novel/chapter_blueprint`
  落库（`chapters.blueprint_json`，同时可设章节级 `target_words`）→ 按蓝图成文；
- 落库后蓝图随 `/api/novel/context` 与 `/api/ai_context` 进入写作上下文，`novel_consistency`
  以其为核对锚点；dsh GUI 会话可用 `novel_blueprint` 工具保存；
- 目标字数优先级：章节 `target_words` > 作品 `default_chapter_words`（默认 2000）> 兜底 2000；
  成文不足时工坊自动续写补足（≤2 轮拼稿），结果弹窗按目标字数对比提示。

### 4. 多关键词加权检索（/api/search）

查询词按空白拆分为多个关键词（≤5 个），全部 AND 匹配；名称/标题命中 ×3 权重、标签/身份 ×2、
内容 ×1，全词相等 > 前缀 > 包含；按得分排序取前 20，片段围绕最早命中的关键词截取；
前端对标题与片段做关键词高亮（`<mark class="search-hit">`）。

### 4. 模型切换竞态修复（harness.js）

dsh 默认模型存于全局 settings.yaml。旧实现直接改写文件，并发任务互相覆盖；
现改为：进程内互斥串行化「改 → 跑 → 还原」+ CAS 还原（文件仍等于我们写入的内容才恢复）。

### 5. 本地安全

- 服务端不再返回 `Access-Control-Allow-Origin: *`：跨源页面无法读取 API Key 与作品数据；
- 浏览器跨源写请求（Origin 非 localhost/127.0.0.1）一律 403；
- 请求体上限 2MB；红线模式长度上限 500、regex 编译校验。

## 三、端点一览

| 端点 | 说明 |
| --- | --- |
| `GET /api/novel/ping` | 服务探活 |
| `GET /api/novel/context?work_id=&chapter_id=&mode=` | ST 式分层上下文（full/continuation/fragment，分层预算 + 蓝图层 + 目标字数） |
| `GET/PUT /api/novel/redlines?work_id=` | 读取/全量替换红线清单（校验类型/长度/正则） |
| `POST /api/novel/scan` | 正文红线扫描 `{work_id,text,skip_dialogue}` → hits |
| `GET/POST /api/novel/events` | 事件账本读取/追加（伏笔状态/回收/dedup/proposed） |
| `GET /api/novel/foreshadows?work_id=&status=` | 未闭合（open）或全部（all）伏笔 |
| `POST /api/novel/consistency` | 一致性核对清单装配 `{work_id,chapter_id,text}` |
| `PUT /api/novel/chapter_blueprint` | 保存章节蓝图 `{chapter_id, blueprint{6字段}, target_words}` |
| `POST /api/novel/chapter_save` | 成稿写回章节（旧稿存历史版本，返回红线扫描） |
| `GET /api/search?q=&work_id=` | 多关键词加权检索（AND 匹配/标题加权/片段定位） |
| `GET /api/novel/proposals?work_id=` | 待确认入账提案 |
| `POST /api/novel/proposals/apply` / `reject` | 采纳/忽略提案 `{work_id, ids|all}` |
| `PUT /api/story_memory` | 提交记忆（summary/delta、proposed；返回 needs_compression） |
| `GET /api/story_memory/versions?work_id=` | 记忆版本历史（每作品保留最近 200 个） |
| `POST /api/story_memory/rollback` | 回滚到指定记忆版本 |
| `POST /api/harness/run` | 启动 dsh 任务（注入身份 + 提案模式 env，202 job_id） |
| `GET /api/harness/job?id=` | 任务状态（output/scan/proposals） |

## 四、dsh 侧挂载（install.ps1 自动完成）

1. **GUI/交互会话**：agent preset 安装到 `~/.dsh/.agent-presets/novel-writing/`
   （`agent.cordis.yml` + `preset.yml` + `novel-tools.mjs`）。
2. **novel-studio 后台 headless（关键）**：`headless-cordis.patch.yml` 以**区块合并**方式
   注入 `~/.dsh/profiles/headless/cordis.patch.yml`（整段替换本插件区块、保留用户其它条目），
   并覆盖 `system-prompt.persona` 注入创作纪律；`novel-tools.mjs` 复制到同目录。

两个安装点的工具与人设同源（本目录文件），升级 = 覆盖本目录后重跑 `install.ps1`。

## 五、已知边界与后续

- headless profile 的补丁对该 profile 所有任务生效（本机 headless 基本只被 novel-studio 使用）；
  人设文本已声明“非创作任务按任务执行”，无副作用。如需按任务条件化，可改用 `!!js` 判断
  `NOVELSTUDIO_WORK_ID`（见 cordis 补丁语法）。
- 记忆 delta 是“安全拼接”约定，语义压缩由模型在调用 `novel_memory_update` 时完成；
  直接 `PUT /api/story_memory` 传 delta 会得到待压缩的追加文本。
- `novel_consistency` 只做确定性清单装配，冲突判断由模型在同一轮内完成（工具返回清单文本）。
- 提案表暂无自动过期策略：pending 提案长期不处理会累积；后续可在 UI 加“一键清理”。

## 六、验证

```bash
# 服务端冒烟测试（纯 HTTP 断言，不依赖 dsh/模型）
node harness-plugins/novel-writing/test/smoke.mjs

# 手动抽查
curl "http://127.0.0.1:3737/api/novel/ping"
curl -X POST "http://127.0.0.1:3737/api/novel/scan" -H "Content-Type: application/json" \
  -d '{"text":"他嘴角勾起一抹冷笑，眼中闪过一丝复杂。"}'
curl -X POST "http://127.0.0.1:3737/api/novel/scan" -H "Content-Type: application/json" \
  -d '{"text":"“你嘴角勾起的弧度出卖了你。”她淡淡道。","skip_dialogue":true}'
```
