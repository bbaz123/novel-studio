# Novel Studio × dsh 创作内核（ENGINE）

本文记录本次改造：让 dsh（deepseek-harness）在小说生成时**自动尊重世界观/角色卡/长期记忆**，
并按“反 AI 腔”风格契约输出，生成后自动收尾（红线扫描 → 事件账本 → 记忆版本化）。

## 一、架构（两层）

```
novel-studio（数据真相源）
  ├─ 新表：memory_versions（记忆快照/回滚）、story_events（事件账本）、writing_redlines（红线）
  ├─ world_entries.priority（词条优先级，配合 is_pinned 做 ST 式排序）
  ├─ 新端点：/api/novel/*（ping/context/redlines/scan/events）、/api/story_memory 版本与回滚
  └─ /api/harness/run：自动注入 NOVELSTUDIO_WORK_ID/CHAPTER_ID/MODE + 生成后红线扫描
        │ spawn（携带身份 env）
        ▼
dsh headless / dsh 会话
  ├─（确定性层）上下文/红线在 prompt 侧已装配 → 生成即守设定、不 AI 腔
  ├─（agent 层）novel_* 工具：headless profile 用 insert 注入、GUI 会话用
  │   novel-writing preset，二者同源（novel-tools.mjs）：上下文按需拉取、设定查证、
  │   产出自检、事件入账、记忆提交（自动版本快照，可回滚）
  └─（收尾层）红线扫描结果随 /harness/run 响应返回，可展示/二次润色
```

## 二、本仓库变更清单

| 文件 | 变更 |
| --- | --- |
| `db.js` | 新增 `story_events`、`memory_versions`、`writing_redlines` 三张表 + 索引；`world_entries.priority`（新库建表 + 旧库 ALTER）；索引 |
| `server.js` | 创作内核模块：默认红线清单（28 条，可编辑）、`listRedlines/replaceRedlines/renderStyleContract/scanAgainstRedlines`；`saveStoryMemory` 每次变更写 `memory_versions` 快照；`buildNovelContext`（ST 式分层装配，mode=full/continuation/fragment）；`mergeMemoryDraft`（增量拼接约定）；`buildAIContext` 增强（前文衔接、最近事件、红线/风格契约字段）；新增路由见下表；`/api/harness/run` 注入身份 env + 返回 `scan` 字段 |
| `harness.js` | `runHarnessTask` 支持 `options.env`（透传给 headless 子进程） |
| `public/app.js` | harness 请求携带 work_id/chapter_id/mode；AI 上下文消息追加“前文衔接/最近事件/写作红线”区块 |
| `harness-plugins/novel-writing/` | 本 ENGINE.md + 配套说明 |

## 三、新增端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/novel/ping` | 服务探活 |
| `GET /api/novel/context?work_id=&chapter_id=&mode=` | ST 式分层上下文（full/continuation/fragment） |
| `GET/PUT /api/novel/redlines?work_id=` | 读取/全量替换红线清单 |
| `POST /api/novel/scan` | 正文红线扫描 `{work_id,text}` → hits |
| `GET/POST /api/novel/events` | 事件账本读取/追加 |
| `GET /api/story_memory/versions?work_id=` | 记忆版本历史 |
| `POST /api/story_memory/rollback` | 回滚到指定记忆版本 |
| `PUT /api/story_memory` | 提交记忆（支持 `summary` 或 `delta` 增量；可选 `source/note`） |

## 四、dsh 侧挂载（两处，均已实测可用）

1. **GUI/交互会话**：选择 agent preset `novel-writing`（装到 `~/.dsh/.agent-presets/novel-writing/`）。
2. **novel-studio 后台生成的 headless 会话（关键）**：把本插件注入 headless profile——
   编辑 `~/.dsh/profiles/headless/cordis.patch.yml`，用 **`insert:` 语法**加入工具行
   （普通 id/name 行会被忽略，这是最初探针“看不到工具”的原因），并覆盖 `system-prompt.persona`
   注入创作纪律。`novel-tools.mjs` 放在该 profile 目录（`name: ./novel-tools.mjs`，相对补丁文件目录解析）。
   之后 novel-studio 每次 `/api/harness/run` 调起的 dsh 任务都自带 `novel_*` 工具与人设，
   身份通过 `NOVELSTUDIO_WORK_ID/CHAPTER_ID/MODE` 环境变量注入，工具自动定位到当前作品/章节。

   补丁要点：
   ```yaml
   - id: system-prompt
     config:
       persona: >- …（创作纪律，见实际文件）
   - insert:
       - id: novel-tools
         name: ./novel-tools.mjs
         config:
           baseUrl: 'http://127.0.0.1:3737'
   ```

   验证（headless 枚举工具应出现 `novel_context/novel_works/novel_lookup/novel_scan/
   novel_style_contract/novel_event_add/novel_memory_update`）：
   ```bash
   pnpm dsh --profile headless "只输出一行：你当前可用的全部工具名称，用逗号分隔"
   ```

## 五、已知边界与后续

- headless profile 的补丁对**该 profile 所有任务**生效（本机 headless 基本只被 novel-studio 使用）；
  非创作类 headless 任务不受影响（人设文本已声明按任务执行，多余调用不做）。
- 若需“只有小说任务才启用”，可把 persona 用 `!!js` 条件化（按 `NOVELSTUDIO_WORK_ID` 环境变量），
  工具本身在非创作任务里不会被模型调用，无副作用。
- 未来阶段 2：把 `novel_*` 提炼为 deepseek-harness 原生 Cordis 插件（见 NATIVE_PLUGIN_GUIDE.md），
  可挂到 web/headless 两种 profile 并便于随仓库分发。
- 记忆 delta 是“安全拼接”约定，语义压缩由模型在调用 `novel_memory_update` 时完成；
  直接调用 `PUT /api/story_memory` 传 delta 会得到待压缩的追加文本。

## 六、验证

```bash
# 服务端启动后
curl "http://127.0.0.1:3737/api/novel/ping"
curl "http://127.0.0.1:3737/api/novel/redlines"
curl -X POST "http://127.0.0.1:3737/api/novel/scan" -H "Content-Type: application/json" \
  -d '{"text":"他嘴角勾起一抹冷笑，眼中闪过一丝复杂。"}'
```
