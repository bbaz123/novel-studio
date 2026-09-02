# Novel Studio · 小说创作工坊

Novel Studio 是一个本地运行的小说创作管理工具，用于管理多部作品的设定、剧情线、大纲、正文写作，并把 AI 辅助创作能力整合进一个清爽的界面。

它不需要安装任何 npm 第三方依赖，使用 Node.js 内置能力与本地 SQLite 数据库即可运行。你的作品数据、API Key 默认只保存在本机。（基于dshAI生成，有任何问题，请直接询问dsh）
专属插件地址：https://github.com/bbaz123/novel-writing-plugin
---

## ✨ 功能亮点

### 作品管理

- 多部作品管理，完整层级：**作品 → 卷 → 章节 / 场景**
- 作品列表页只展示“我的作品”，入口简洁
- 作品支持新建、编辑简介、删除

### 重新整理后的侧边栏

进入作品后，左侧只保留几个大栏目，避免界面杂乱：

- **总览**：作品数据总览、最近更新、快捷入口
- **正文写作**：章节树 + 富文本编辑 + AI 写作
- **小说设定**：剧情线、大纲、设定库、角色、长期记忆
- **AI创造板块**：AI 创作、AI 设置、SillyTavern 设置

### 小说设定板块

集中管理所有与“故事设定”相关的内容：

- **剧情线**：主线 + 支线，章节节点时间线预览
- **大纲**：思维导图 / 列表两种模式，支持卷、章节 / 场景树
- **设定库**：分类 + 标签 + 词条详情，支持在正文中关联词条
- **角色**：基础档案、外貌、性格、背景、当前状态、人物关系、剧情线级状态
- **长期记忆 / 故事摘要**：记录已发生的重要剧情、伏笔、角色状态变化，AI 写作时会自动带入

### 正文写作

- 富文本编辑：加粗、斜体、下划线、标题、引用、列表
- 自动保存、实时字数统计
- 单栏 / 两栏 / 三栏布局切换
- 手动保存历史版本，可查看与恢复
- 正文内选中文字可关联设定词条，悬停预览、点击跳转
- 右侧参考面板可快速查看设定、角色与 AI 上下文

### AI 创作能力

- **AI 设置**：管理 DeepSeek / OpenAI 兼容 API 配置，支持连接测试
- **AI 写作 / 续写**：在正文工具栏使用；AI 会先向你提问，一次只问一个问题，根据你的回答继续追问，直到理解需求后再生成正文
- **AI 润色、扩写、细纲、性格校对**
- **AI 自动创建小说**：输入一段描述，AI 自动完善设定并创建作品
- **AI 创作工作台 / Harness 流水线**：分阶段生成世界观、角色卡、大纲、正文草稿并做一致性审查
- **SillyTavern 设置**：管理角色卡、世界观词条、作者注，用于丰富 AI 上下文

### 全局能力

- 全局搜索：设定词条 / 章节正文 / 角色 / 剧情线
- 本地 SQLite 存储，无需外部数据库服务
- 深色护眼主题

---

## 🚀 运行方式

### 环境要求

- **Node.js 22.5+**
- 现代浏览器（Chrome / Edge 等）

### 启动

```bash
cd novel-studio
npm start
```

然后打开浏览器访问：

```text
http://localhost:3737
```

也可以直接运行：

```bash
node server.js
```

> 本项目使用 Node.js 内置 `node:sqlite`，**无需执行 `npm install`**。

---

## 🤖 AI 功能配置

AI 相关功能需要先配置可用的模型后端。

### 1. 配置 API（在应用内完成）

打开作品后进入：

```text
AI创造板块 → AI 设置
```

新建 API 配置并填写：

- 配置名称
- Base URL（DeepSeek 默认 `https://api.deepseek.com`）
- API Key
- 模型
- 温度、最大 Token

### 2. 配置 DeepSeek Harness（可选但推荐）

本项目的 AI 创作 / 深度写作通过 `deepseek-harness`（dsh）执行。若未安装，AI 写作与自动创作可能不可用。

可以通过环境变量指定 Harness 所在目录：

```bash
# Windows PowerShell
$env:DSH_HOME = "C:\path\to\deepseek-harness"
npm start

# macOS / Linux
export DSH_HOME="/path/to/deepseek-harness"
npm start
```

如果未设置 `DSH_HOME`，程序会使用当前机器上的默认本地路径；在其它电脑上运行时请改为实际路径。

---

## 🧭 界面导航速览

| 入口 | 说明 |
| --- | --- |
| 我的作品 | 未进入作品时唯一显示的栏目，管理所有小说项目 |
| 总览 | 当前作品的章节数、设定数、角色数、剧情线数 |
| 正文写作 | 选择章节并写作，支持 AI 写作与富文本排版 |
| 小说设定 | 剧情线 / 大纲 / 设定库 / 角色 / 长期记忆 |
| AI创造板块 | AI 创作 / AI 设置 / SillyTavern 设置 |

---

## 📁 项目结构

```text
novel-studio/
├── public/
│   ├── index.html      # 页面骨架与侧边栏
│   ├── styles.css      # 样式与深色主题
│   └── app.js          # 前端交互逻辑
├── db.js               # SQLite 初始化与建表
├── server.js           # HTTP 服务与 API 路由
├── harness.js          # DeepSeek Harness 桥接层
├── harness-plugins/    # Harness 创作插件（可选）
├── package.json
├── start-novel-studio.cmd
├── create-desktop-shortcut.ps1
└── data/               # 本地数据库（不会上传到 Git）
```

---

## 🗄️ 数据与隐私

- 所有数据保存在本机：`novel-studio/data/novel.db`
- API Key 也只保存在本地 SQLite 数据库中
- `data/` 目录已被 `.gitignore` 排除，**不会随仓库上传**
- 首次启动时如果数据库不存在，程序会自动创建所需的表结构

---

## ⚠️ 注意事项

- 请勿将 `data/novel.db` 直接分享或上传，其中可能包含你的 API Key 与作品内容
- AI 请求会发送到你配置的模型服务商；如使用云端服务，请注意敏感信息
- 若修改了 `server.js` 或 `db.js`，重启服务后生效
