# Novel Writing 创作插件（内置版 · 面向 Novel Studio）

这是 **Novel Studio（小说创作工坊）内置的创作插件**：不是独立分发、不依赖外部仓库，
插件的 dsh 侧源码与工坊服务端创作内核**同仓维护、一起升级**。

> **仓库关系**：本目录的规范源在 novel-studio 仓库的 `harness-plugins/novel-writing/`。
> 若本目录同时以独立仓库（bbaz123/novel-writing-plugin）发布，则该仓库是发布镜像：
> 两份文件内容保持一致；安装请优先使用 novel-studio 仓库内的版本。

```
novel-studio/
├─ db.js / server.js / harness.js / public/app.js   ← 工坊主体（创作内核：上下文装配/红线/事件账本/记忆版本/提案确认）
└─ harness-plugins/novel-writing/                   ← 本插件（dsh 侧唯一来源）
   ├─ novel-tools.mjs           # novel_* 工具集（headless 与 GUI preset 同源）
   ├─ agent.cordis.yml          # GUI 会话 preset（写作人设 + novel_* 工具 + fs）
   ├─ preset.yml                # preset 元信息
   ├─ headless-cordis.patch.yml # 注入 headless profile 的区块片段（合并式安装）
   ├─ install.ps1               # 一键安装/升级/卸载（区块合并、保留用户其它 patch）
   ├─ plugin.json               # 清单：工具/端点/契约（文档与测试的唯一真源）
   ├─ test/smoke.mjs            # 端到端冒烟测试（node:test）
   ├─ ENGINE.md                 # 架构、端点、验收细节
   ├─ NATIVE_PLUGIN_GUIDE.md    # 如何在工坊内扩展本插件
   └─ README.md                 # 本文件
```

## 安装（两步）

```powershell
# 1) 工坊本体：直接使用 novel-studio 仓库（创作内核已内置，无需覆盖任何补丁文件）。
#    重启：npm start（数据库启动时自动迁移新表/新列）

# 2) dsh 侧（本目录；发布镜像仓库中本目录即仓库根）：
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 预演不落盘：… install.ps1 -DryRun    卸载：… install.ps1 -Uninstall
```

完成后打开 novel-studio 使用 AI 创作即可——后台 headless dsh 自动携带 novel 工具与创作纪律，
无需在 dsh 界面手动选 preset（身份经 `NOVELSTUDIO_WORK_ID/CHAPTER_ID/MODE` 环境变量注入）。

## 验证

```bash
# 服务端冒烟测试（不依赖 dsh，纯 HTTP 断言；需能定位到 novel-studio 仓库，
# 或用 NOVELSTUDIO_REPO 环境变量指定其根目录）
node test/smoke.mjs

# dsh 侧工具目录
cd <你的 deepseek-harness 目录>
pnpm dsh --profile headless "只输出一行：你当前可用的全部工具名称，用逗号分隔"
# 期望出现：novel_context, novel_works, novel_lookup, novel_scan, novel_style_contract,
#           novel_event_add, novel_memory_update, novel_foreshadows, novel_consistency, novel_chapter_save
```

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `novel_context` | 取作品/章节分层上下文（大纲/记忆/事件/未闭合伏笔/前后章衔接/角色卡/激活世界观/红线），分层预算截断 |
| `novel_works` | 列出作品（确认 work_id） |
| `novel_lookup` | 关键词检索角色/词条/章节/剧情线（写前查证设定） |
| `novel_foreshadows` | 列出未闭合（或全部）伏笔 |
| `novel_consistency` | 成文后一致性核对：未闭合伏笔/出场角色状态/最近事件 vs 正文 |
| `novel_scan` | 确定性反 AI 腔红线扫描（可跳过引号内对话） |
| `novel_style_contract` | 读取写作红线清单 |
| `novel_event_add` | 事件/伏笔/状态变化入账（伏笔状态与回收、幂等去重；headless 先落提案） |
| `novel_memory_update` | 长期记忆摘要压缩/增量提交（版本快照可回滚；headless 先落提案） |
| `novel_chapter_save` | 成稿写回章节正文（旧稿自动存历史版本，返回红线扫描） |

## 关键机制

- **提案确认（headless 防污染）**：novel-studio 网页启动的任务带 `NOVELSTUDIO_PROPOSE_MODE=1`，
  AI 的事件/记忆入账先落提案表，任务结束随结果返回；作者在「AI 写作结果」弹窗勾选采纳，
  或稍后在「小说设定 → 长期记忆 → 📥 待确认提案」里处理。GUI dsh 会话里作者在场，直接入账。
- **伏笔闭环**：`novel_foreshadows` 查欠账 → 正文显式呼应 → `novel_event_add(resolves_event_id=…)`
  自动把旧伏笔标记 resolved；`novel_context` 里始终带【未闭合伏笔】层。
- **分层上下文预算**：每层独立上限、红线/角色卡保底、总量收敛截断，超长记忆标注压缩提示，
  不再一刀切盲截。
- **红线扫描**：默认 28 条反 AI 腔红线，作品级可覆盖（`PUT /api/novel/redlines`）；
  扫描支持 `skip_dialogue`（引号内台词不计），正则模式有长度上限与编译校验。
- **幂等与保留**：事件按 `dedup_key` 去重；记忆版本每作品保留最近 200 个，超限自动剪除；
  正文写回前自动存章节历史版本。

## 安全（本地工具也要防）

- 服务端不再返回 `Access-Control-Allow-Origin: *`：跨源页面无法读取本地 API Key 与作品数据；
  浏览器跨源写请求（POST/PUT/DELETE）一律 403。
- 请求体上限 2MB；红线正则长度上限 500；非法 JSON/非 JSON 响应显式报错。

## 卸载 / 回退

```powershell
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Uninstall
```

- 删除 `~/.dsh/.agent-presets/novel-writing`（GUI preset）
- 从 `~/.dsh/profiles/headless/cordis.patch.yml` 中整段移除本插件区块（保留其它 patch 条目）
- 工坊服务端的新表/新列向后兼容（旧功能不受影响），建议保留

## 环境要求

- Windows（安装脚本为 PowerShell；模块为纯 ESM JS，无第三方依赖）
- Node.js 22.5+（novel-studio 本体）+ 已构建的 deepseek-harness（dsh）仓库 + headless profile
- novel-studio 本地服务（http://127.0.0.1:3737，`PORT` 可覆盖；dsh 工具通过 `NOVELSTUDIO_BASE_URL` 自动定位）
- 应用本体：https://github.com/bbaz123/novel-studio
