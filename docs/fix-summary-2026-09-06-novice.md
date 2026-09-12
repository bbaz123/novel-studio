# 修复摘要 · 新人体验优化（2026-09-06，v0.9.2）

依据 docs/novice-experience-report.md 的 13 项发现（N-01~N-13）实施全栈修复。
验证：全部改动文件 node --check 通过；冒烟测试 31 组断言通过；隔离实例实测同步与
harness 中文通道；主实例（3737）已重启加载新代码。

## P0（阻塞级）

- **N-01 AI 写作中文变「?」——已修复**
  - 根因：harness.js 通过 pnpm 运行 dsh 脚本，Windows 上 pnpm 经 cmd.exe 执行，
    把中文 prompt 按 ANSI 代码页损坏成「?」。
  - 修复：harness.js 新增 resolveDshLaunch()，按 dsh 仓库 package.json 的
    scripts.dsh 定义直接以 node spawn 启动 CLI（纯 node spawn 传中文参数实测完好），
    找不到定义时回退旧的 pnpm 方式。
  - 配套：harness-plugins/novel-writing/novel-tools.mjs 的 baseUrl 改为
    NOVELSTUDIO_BASE_URL 环境变量优先（多实例时 novel_* 工具回连发起任务的实例，
    不会串写主库）；已同步到 headless profile 安装目录。
  - 验证：隔离实例真实 harness 任务（中文 prompt「请只输出四个字：编码正常」）
    返回「编码正常」；此前同一链路返回满屏「?」并拒绝执行。
- **N-02 AI 任务失败不可见——已修复**
  - public/app.js：AI 写作任务异常/空输出时弹出「⚠️ AI 写作未完成」错误框，
    回显 AI 原始输出尾部；空输出/空正文的 throw 携带 rawOutput 供弹窗展示。
- **N-03 记忆库按作品自增 id 串作品——已修复**
  - db.js：works 表新增 ov_uri 列（含旧库迁移）；新作品由触发器自动分配 32 位
    随机 hex 目录标识。
  - openviking-sync.js：workDir() 改用 ov_uri；旧作品首次同步回填「<id>」保持
    既有记忆库目录布局不变。
  - 验证：隔离实例新作品目录为随机 hex；用户主库旧作品（id=2/9）回填保持原目录。
- **N-04 OpenViking 同步半失效——已修复**
  - 根因：① write 的 upsert 模式不被服务端单文件接口支持；② batch-write 对
    尚不存在的目标文件返回 404（File not found）。
  - 修复：全部改为单文件 write（replace 幂等）；先写 meta.md 建目录再逐条写入；
    移除 batch-write 依赖与 chunkOperations 死代码。
  - 验证：隔离实例新作品 4 个文件（meta/long-memory/events/outline）完整落库，
    日志无 queue_dropped。

## P1

- **N-05 相关度显示 8800%——已修复**：recallPercent 兼容两种量纲（≤1 视为小数）。
- **N-06 后台标签页被误报「主线程阻塞」——已修复**：卡顿监控在页面隐藏时跳过采样。

## P2

- **N-07 测试连接结果不可见 / AI 请求误记慢请求——已修复**：配置卡驻留显示
  「上次测试：成功/失败 · 时间」；AI 通道慢请求阈值前后端均放宽到 10s。
- **N-08 词条数口径不一——已修复**：示例导入提示改为同时报「设定词条」与
  「世界观词条」两个口径（与总览统计一致）。
- **N-09 两套词条体系无说明——已修复**：SillyTavern 设置页世界观词条区加说明文案。
- **N-10 关闭服务按钮文案技术化——已修复**：确认文案口语化并说明后果；按钮文案
  改为「⏻ 关闭服务」。
- **N-11 ◀ 形似返回——已修复**：侧栏折叠按钮加 title 提示（收起/展开侧栏）。
- **N-12 语义召回混入目录元数据与空占位——已修复**：召回层过滤「.」开头的
  元数据文件与「（暂无…）」占位文件。
- **N-13 主实例旧代码明文返回 API Key——已处理**：3737 实例已重启，Key 掩码生效。

## 未修改项及原因

- public/styles.css、public/index.html：本轮改动未引入新样式类/结构（错误弹窗与
  状态行用内联样式），无需改动。
- openviking.js：batchWrite 能力保留（服务端修复后可恢复批量路径），仅同步层停用。
- dsh 仓库（deepseek-harness）与 harness-plugins 的 install.ps1/preset：
  N-01 在工坊侧 harness.js 解决，不侵入 dsh 源码；install.ps1 无需变更
  （novel-tools.mjs 内容更新，安装时随文件覆盖）。
- README.md：已追加本次版本更新说明；demo-data.json 未动。