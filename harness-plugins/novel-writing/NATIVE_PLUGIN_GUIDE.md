# DeepSeek Harness 原生插件实现指南

本文说明如何把 Novel Studio 的小说创作工具封装为 dsh 原生 Cordis 插件。

## 插件位置

建议放在 deepseek-harness 仓库内：

```text
deepseek-harness/packages/novel/plugin-novel-writing/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

## package.json 要点

```json
{
  "name": "@deepseek-ai/dsh-plugin-novel-writing",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^",
    "@deepseek-ai/cordis": "workspace:^"
  }
}
```

## 插件入口示例

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'plugin-novel-writing'
export const inject = ['tools']

export interface Config {
  defaultModel: string
}

export const Config: z<Config> = z.object({
  defaultModel: z.string().default('deepseek-v4-pro'),
})

export function apply(ctx: Context, config: Config) {
  ctx.tools.set('story_architect', defineTool({
    description: '生成小说世界观设定',
    input: z.object({
      prompt: z.string(),
    }),
    async output({ prompt }) {
      // 这里可以调用 Novel Studio API 或直接调用 LLM
      return { result: `世界观创作请求：${prompt}` }
    },
  }))

  ctx.tools.set('chapter_writer', defineTool({
    description: '生成小说章节正文',
    input: z.object({
      outline: z.string(),
      model: z.string().default(config.defaultModel),
    }),
    async output({ outline }) {
      return { result: `章节创作请求：${outline}` }
    },
  }))
}
```

## 挂载到 headless profile

在 `~/.dsh/profiles/headless/cordis.patch.yml` 中加入：

```yaml
- id: plugin-novel-writing
  config:
    defaultModel: deepseek-v4-pro
```

然后运行：

```bash
cd deepseek-harness
pnpm install
pnpm dsh --profile headless "创作一部小说"
```

## 当前状态

Novel Studio 已经通过 `harness.js` 桥接实现了上述工具的等价功能。  
本指南用于后续把工具正式封装为 dsh 原生插件。
