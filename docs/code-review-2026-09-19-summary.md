# C-代码审查总结

## 执行概览

- 审查对象：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`
- 执行流程：第 1～5 步全部完成
- 修改原则：质量优先，未降低 AI 文本质量、上下文连贯性或生成速度
- Git 状态：仅修改工作区文件，未执行 `git commit`

## 第 1 步：第一次代码审查

- 已完成项目全量静态审查与定位。
- 输出报告：`docs/code-review-2026-09-19.md`
- 未修改业务代码。

## 第 2 步：第二次代码审查与修改

### 主要发现与修改

- **Q1 压缩出场判定只读章节头部**
  - 修改：压缩与护栏出场判定改为同时读取章节头尾各 2000 字，覆盖后期出场实体。
  - 文件：`server.js`
- **Q2 压缩提示词只截取开头**
  - 修改：改为“全部章节摘要覆盖 + 最近章节尾部 + 紧凑角色/世界观列表”。
  - 文件：`server.js`
- **Q4 前端旧拼装兜底**
  - 修改：`loadAIContext` 缺失 `assembled` 时回退 `/novel/context`；`aiContextBlock` 只使用服务端 `assembled`。
  - 文件：`public/app.js`
- **R1 畸形 URL 解析抛穿请求**
  - 修改：`getPath` 异常返回 `400` 并记录 warn。
  - 文件：`server.js`
- **R2 ZIP/EPUB 解压无上限**
  - 修改：增加单条目 128MB、整包 256MB 解压上限。
  - 文件：`zip-reader.mjs`

### 本步测试

- `node --check server.js`：通过
- `node --check public/app.js`：通过
- `node --check zip-reader.mjs`：通过
- `node .p1-baseline/test-memory-compress-guard.mjs`：54/54 通过
- `node .p1-baseline/test-agent-memory-guard.mjs`：37/37 通过
- `node frontend-test.mjs`：ALL PASS
- `node harness-plugins/novel-writing/test/smoke.mjs`：36/36 通过

## 第 3 步：质量优先优化

### 主要发现与修改

- **O1 空回复重试质量阶梯**
  - 修改：`directAIWrite` 与 `streamAIDirectWrite` 首次空回复先保持原思考强度并提高 `max_tokens`，仍为空才降为 `low` 兜底。
  - 文件：`public/app.js`
- **O2 上下文并发去重**
  - 修改：`loadAIContext` 复用同一 `workId:chapterId` 的在途请求，并避免切章后写入陈旧上下文。
  - 文件：`public/app.js`
- 同步更新测试断言。
  - 文件：`frontend-test.mjs`

### 本步测试

- `node --check public/app.js`：通过
- `node --check frontend-test.mjs`：通过
- `node frontend-test.mjs`：ALL PASS

## 第 4 步：兼容性与适配性检查

### 主要发现与修改

- **C1 `loadAIContext` 的 workId 回退口径**
  - 修改：`workId` 取值改为 `state.workId || state.work?.id || 0`，与项目其他调用位置保持一致。
  - 文件：`public/app.js`

### 本步测试

- `node --check public/app.js`：通过
- `node frontend-test.mjs`：ALL PASS

## 第 5 步：最终审查与修复

### 主要发现与修改

- **F1 `fresh()` 与 `workId` 回退口径不一致**
  - 发现：`workId` 已支持 `state.work?.id` 回退，但 `fresh()` 仍只判断 `state.workId`，个别状态会误判为切章，导致请求成功后不写入上下文。
  - 修改：`fresh()` 改为 `(state.workId || state.work?.id || 0) === workId`。
  - 文件：`public/app.js`

### 本步测试

- `node --check public/app.js`：通过
- `node frontend-test.mjs`：ALL PASS

## 测试结果汇总

- 所有已执行检查均通过，未触发失败重试。
- 静态语法检查：`server.js`、`public/app.js`、`zip-reader.mjs`、`frontend-test.mjs` 全部通过。
- 离线护栏测试：记忆压缩 54/54，模型自压缩记忆护栏 37/37。
- 前端回归：`frontend-test.mjs` ALL PASS。
- 集成冒烟测试：`harness-plugins/novel-writing/test/smoke.mjs` 36/36。

## 遗留问题

- **Q5 `computeFloor` 对 fixed 层提示语核算口径**
  - 仅影响文档/审计口径，不影响项目运行与内容质量；本次未修改。
- **R3 静态路径字符串前缀判断**
  - 低风险静态文件路径检查问题，本次未修改；建议后续以 `path.relative` 或统一路径边界判断优化。
- **Q3 空回复降级重试**
  - 第 2 步原定暂缓；第 3 步已按质量优先原则改为“先保思考强度、再降级兜底”，已闭环，不再作为遗留问题。
- **未新增额外上下文持久缓存**
  - 为避免陈旧上下文影响内容质量，本轮未增加更多缓存层；现有服务端上下文缓存、语义召回微缓存与前端并发去重已覆盖主要热点。

## 修改文件清单

- `server.js`
- `public/app.js`
- `zip-reader.mjs`
- `frontend-test.mjs`
- `docs/code-review-2026-09-19.md`（第 1 步的审查报告；交付时由 `C-第一次代码审查报告.md` 归档进 `docs/`）
- `docs/code-review-2026-09-19-summary.md`（本总结；交付时由 `C-代码审查总结.md` 归档进 `docs/`）
