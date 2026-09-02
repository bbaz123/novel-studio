# Novel Writing Plugin Pack

这是 Novel Studio 为 DeepSeek Harness 设计的小说创作插件包清单。

当前 Novel Studio 已通过 Harness headless 实现这些工具对应的创作流程；后续可进一步封装为 dsh 原生 Cordis 插件。

## 工具列表

- `story_architect`：世界观架构
- `character_designer`：角色卡设计
- `outline_planner`：分卷/章节大纲
- `chapter_writer`：章节正文写作
- `consistency_checker`：一致性审查
- `memory_compressor`：长期记忆压缩

## 模型路由

| 策略 | 草稿 | 精修/审查 |
| --- | --- | --- |
| 快速 | deepseek-v4-flash | deepseek-v4-flash |
| 均衡 | deepseek-v4-flash | deepseek-v4-pro |
| 深度 | deepseek-v4-pro | deepseek-v4-pro |

## 接入方式

Novel Studio 通过 `harness.js` 桥接层调用：

```js
runHarnessTask(prompt, {
  timeout: 600000,
  model: 'deepseek-v4-pro'
});
```

后续若需要真正的 dsh 原生插件，可基于本清单在 deepseek-harness 的 packages 中实现 Cordis 插件并挂载到 headless profile。
