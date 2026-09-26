# 第三方组件与资产

本文件列出 Novel Studio 仓库内**不由本项目 MIT 许可证覆盖**的第三方组件与资产，各自遵循其上游条款。

---

## 1. 向量模型 `vendor/models/bge-small-zh-v1.5-f16.gguf`

| 项目 | 内容 |
| --- | --- |
| 用途 | OpenViking 共享记忆库的本地向量模型（512 维中文 dense embedding，GGUF 格式，由 llama.cpp 加载） |
| 上游模型 | `BAAI/bge-small-zh-v1.5`（模型卡标注 **MIT**） |
| GGUF 转换件 | [`CompendiumLabs/bge-small-zh-v1.5-gguf`](https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf) |
| 分发方式 | 本仓库**原样随源码分发**（不改动任何字节） |
| 字节数 | 47,886,240 |
| SHA256 | `ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c` |
| 校验命令 | `node scripts/fetch-embedding-model.mjs --verify-only`（离线） |
| 来源与维护说明 | [vendor/README.md](vendor/README.md)；配置方法见 [docs/openviking-embedding-setup.md](docs/openviking-embedding-setup.md) |

> ⚠️ 上游镜像对该文件返回的 `ETag` 与真实内容 SHA256 **不一致**，校验一律以上表列出的 SHA256 为准
> （该值由"镜像下载件"与"本机缓存件"两份独立算出并等同确认）。

---

## 2. 独立项目（不包含在本仓库内）

以下项目是 Novel Studio 的**可选**协作方，代码不在本仓库内，安装与使用时遵循它们各自的许可证：

| 项目 | 关系 | 许可证 |
| --- | --- | --- |
| **DeepSeek Harness（`dsh`）** | AI 能力宿主：Novel Studio 通过它调度模型与工具 | 见其自身仓库 |
| **OpenViking** | 共享记忆库（语义召回） | 见其自身仓库 |
| ***SillyTavern*** | 设计上借鉴了它的世界观 / 角色卡组织方式 | 见其自身仓库 |

---

## 3. 前端运行时依赖

Novel Studio 前端**不使用任何 npm 运行时依赖**（`package.json` 的 `dependencies` 为空），
因此仓库内不包含需要额外声明许可的第三方 JavaScript 库。
