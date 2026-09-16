# P3 验收报告：检索覆盖面与「凡裁剪必可查回」

> 阶段：P3（扩展检索覆盖面，落实契约 I4）
> 日期：2026-09-15　状态：**代码部分完成并实测通过**；记忆库索引缺失一项**待你决策**

---

## 一、目标

P2 让上下文有了预算与裁剪清单，但**被裁掉的内容取不回来**——`verify-invariants.mjs`
实测出的 I4 工作清单是：长期记忆单次被裁 6,863 字、事件账本 4,620 字、世界观 15,359 字、
伏笔 2,117 字、红线 1,394 字……「零损失」此时只是一句口号。

P3 把它变成可断言的不变量：**凡被裁剪，必须能查回原文**。

---

## 二、做了什么

| # | 改动 | 文件 |
|---|---|---|
| 1 | 新增模型工具 `novel_events`（读事件账本，可比上下文「最近事件」层更早、可按类型/章节过滤） | `novel-tools.mjs` |
| 2 | 新增模型工具 `novel_memory_read`（读完整长期记忆，上下文里该层截到 2200 字） | `novel-tools.mjs` |
| 3 | `/api/search` 新增 **世界观** 与 **人物关系** 检索桶（此前完全不在检索范围内） | `server.js` |
| 4 | `/api/search` 的章节字段纳入 **`blueprint_json`**（蓝图此前不在任何检索字段内） | `server.js` |
| 5 | `novel_lookup` 呈现新桶与蓝图全文；工具数 13 → **15** | `novel-tools.mjs` |
| 6 | **查回路径声明进层规格**（`RETRIEVAL`），I4 从散文变成可断言项 | `ai/context/layers.mjs` |
| 7 | 新增 I4 **端到端**验证器（不看声明、实际调端点） | `.p1-baseline/verify-retrieval.mjs` |
| 8 | 新增工具面验证器（用 mock ctx 真正加载插件，列出注册的工具） | `.p1-baseline/verify-plugin-tools.mjs` |
| 9 | persona（两处）补上「分层有预算、被裁内容用哪个工具取回」的指引 | `cordis.patch.yml` / `agent.cordis.yml` |

版本：`plugin.json` / `package.json` / `PLUGIN_VERSION` 三者同步升至 **0.8.2**。

---

## 三、验收证据

### 3.1 I4 实测：9 个被裁层全部可取回

`node .p1-baseline/verify-retrieval.mjs http://127.0.0.1:3739 .p1-baseline/stress-data/novel.db 16 227`

| 层 | 类型 | 被裁 | 查回路径 | 实测 |
|---|---|---|---|---|
| `outline` | flex | 8,769 | `novel_lookup` | ✓ chapters 20 / characters 20 |
| **`memory`** | **fixed** | **6,863** | **`novel_memory_read`** | ✓ 端点返回 **9,000 字**（层里只用 2,200） |
| `recall` | cond | 1,259 | —（intrinsic） | 不适用：本层自身就是检索结果 |
| **`events`** | **fixed** | **4,620** | **`novel_events`** | ✓ 端点返回 **150 条**（层里约 9 条） |
| **`foreshadows`** | **fixed** | **2,117** | `novel_foreshadows(status=all)` | ✓ 38 条 = 库里全量 |
| `blueprint` | cond | 2,140 | `novel_lookup` | ✓ 命中带蓝图全文的章节 |
| `relations` | cond | 1,974 | `novel_lookup` | ✓ relations 6 条（**P3 新增桶**） |
| `world` | flex | 15,359 | `novel_lookup` | ✓ world_entries 11 条（**此前该桶不存在**） |
| **`redlines`** | **fixed** | **1,394** | `novel_style_contract` | ✓ 68 条 = 库里全量 |

**结论：I4 成立**（真实数据下没有被裁的层，同样通过）。

### 3.2 工具面与清单一致

`node .p1-baseline/verify-plugin-tools.mjs` → mock ctx 真正加载插件后注册 **15 个工具**，
全部带 schema；与 `plugin.json` 声明的 15 个**完全一致**；三处版本号一致（0.8.2）。

> 为什么必须真正加载：P0 已实测 `dsh --dump-config` **只组合配置、不加载模块**——
> 注入不存在的插件也能启动成功。所以「注册了哪些工具」不能靠 dump-config 证明。

### 3.3 无回归

P3 未触碰装配器，装配结果与 P2 逐字节对照：

```
压力数据  35/35 逐字节一致
真实数据  20/20 逐字节一致
I1 / I2 / I3 / I7 不变量：全部成立
```

bundle 组合树仍为 83 行，仅 2 处预期差异：`system-prompt`（新人设）与 `novel-tools`（包名）。

---

## 四、过程中发现的两个真问题（都不是我引入的）

### 4.1 你在写的那本书，语义召回是**彻底死的**

排查 `work#2`（《我真的只是一个路人啊》）召回为零时，我逐层排除：

1. 阈值/top-k 问题？→ 把 limit 从 8 放大到 48，**永远只返回 5 条**，全是元数据文件
2. 噪声过滤问题？→ 那 5 条确实全是 `.overview.md` / `.abstract.md`，被正确丢弃
3. 客户端调用问题？→ 直接跑生产代码 `getSemanticRecall`，确认 `no-hits`
4. **去看记忆库里到底有什么** →

```
.../novel-studio/2/            ← 只有目录骨架
  chapters/  characters/  settings/  world/     ← 全部为空
  各级 .abstract.md / .overview.md              ← OpenViking 自动生成的元数据
```

对照 `work#16`（我造的压力作品）有 **242 个文件**。

决定性证据在那份 `.overview.md` 的头部：

```yaml
generated_by:
  component: SemanticProcessor
  trigger: content_delete      ← 因「内容被删除」而重新生成
freshness:
  total_entries: 0             ← 目录里 0 个条目
```

时间戳 **2026-09-14 23:23:33–23:24:41**，正好是你 09-14 那场会话的结束时间。

**而 `app_settings` 里 `ov_indexed_at:2 = 2026-09-14T14:51:58Z` 仍然声称"已索引"。**
（`syncWorkFull` 的 OS-07 假成功修复已在位——`allOk` 才写时间戳——所以这是在**成功索引之后**被删掉的。）

**而且这不是孤例**：138 个作品目录里 **79 个（57%）只剩元数据**。

**影响**：这本书的「相关记忆检索（语义召回）」层——13 层里的 1 层、1,400 字预算——
**一直是空的**，模型从未拿到过它。

### 4.2 隔离性隐患：记忆库不是隔离的

记忆库按 `works.ov_uri` 寻址，而 `ov_uri` **随数据库一起被复制**：

```
真实库 data/novel.db        → work#2 的 ov_uri = "2"
副本   .p1-baseline/data/   → work#2 的 ov_uri = "2"   ← 同一个记忆库目录
```

也就是说：**从隔离实例触发一次全量同步，就会写进你生产的记忆库**。
P0 起我一直声称"隔离开发"，对数据库成立，**对记忆库不成立**——这一点此前没有被识别，
现已写入 `.p1-baseline/README.md`。

---

## 五、待你决策

**是否重建 work#2 的索引？**

- 机制上是安全的：`syncWorkFull` 是幂等写（`replace` 模式），不删任何东西
- 代价：本地 bge-small-zh 嵌入计算（无 API 费用），约 25 个文件
- 影响面：写入的是你的**生产记忆库**（`data/viking/...`），且与 GUI 会话共用

我没有擅自执行——按你「改动前评估与确认」的偏好，这属于需要你点头的动作。

顺带建议：**其余 78 个只剩元数据的作品是否也需要重建**，取决于你是否还在用它们。

---

## 六、复现

```powershell
# I4 端到端实测（隔离实例 3739 = 压力数据）
node .p1-baseline/verify-retrieval.mjs http://127.0.0.1:3739 .p1-baseline/stress-data/novel.db 16 227

# 工具面与版本一致性（真正加载插件，不看 dump-config）
node .p1-baseline/verify-plugin-tools.mjs

# 装配回归
node .p1-baseline/capture-baseline.mjs --base http://127.0.0.1:3739 --db .p1-baseline/stress-data/novel.db --out .p1-baseline/baselines-p3
# 与 .p1-baseline/baselines-p2final-stress 逐字节对照

# 记忆库现场（只读）
#   data/viking/default/user/default/resources/novel-studio/<ov_uri>/
```
