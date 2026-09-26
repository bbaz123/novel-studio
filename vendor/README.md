# vendor/ —— 随源码一起走的二进制资产

本目录只放**体积大、但必须能离线拿到**的东西。代码一律不在这里（代码在仓库根与 `ai/`、`harness-plugins/`）。

## 为什么把它放进源码

novel-studio 本体是零依赖的纯 Node 程序，唯一的外部依赖是 DeepSeek Harness（dsh）与可选的 OpenViking 记忆库。
但 OpenViking 要用一个**本地向量模型**才能把作品数据向量化 —— 默认行为是「首次启动时自己去 HuggingFace 下载」。
在本机网络环境下 `huggingface.co` 不可达（握手超时），于是这一步会成为整条记忆链路上唯一必须联网、且必然失败的环节。

所以把它随源码带一份：**OpenViking 的 `ov.conf` 指过来就能用，服务端永远不需要联网下模型。**

## 内容清单

| 路径 | 内容 | 字节数 | SHA256 |
|---|---|---|---|
| `models/bge-small-zh-v1.5-f16.gguf` | 512 维中文 dense embedding 模型（GGUF，llama.cpp 加载） | 47,886,240 | `ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c` |

上游：<https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf>（本机镜像：`https://hf-mirror.com/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf`）

## 这份资产是**随仓库提交**的（不是让你自己去下）

| 事实 | 值 |
|---|---|
| 是否进 git | **是**（`models/bge-small-zh-v1.5-f16.gguf`，47.9MB） |
| 为什么进 | 非技术人员 clone 完就该能直接用；而且**本机网络到 `huggingface.co` 不可达**，把"下载"留给用户等于把整条记忆链路卡死在这一步 |
| 代价 | 仓库体积 +47.9MB（该文件 47.9MB，未触发 GitHub 单文件 100MB 硬限制；clone 会明显变慢） |
| 不想要 | 删掉 `vendor/models/` 即可，产品照常启动；但语义召回就需要你自己准备模型（OpenViking 默认行为是去 HuggingFace 下载——离线环境下必然失败） |
| 校验 | `node scripts/fetch-embedding-model.mjs --verify-only`（离线，按 SHA256 比对） |

上游许可：`BAAI/bge-small-zh-v1.5`（模型卡标注 **MIT**）→ GGUF 转换件 `CompendiumLabs/bge-small-zh-v1.5-gguf`；
本目录只做**原样**分发（第三方清单见根目录 `THIRD-PARTY-NOTICES.md`）。

## 怎么用 / 怎么维护

```powershell
# 核对源码里这份是否与上游一致（不联网）
node scripts/fetch-embedding-model.mjs --verify-only

# 缺失或校验不过时补齐（先镜像后官网，写 .part 再改名）
node scripts/fetch-embedding-model.mjs
```

配置方法（`ov.conf` 的 `model_path` 指到 `models/` 下这一份）、完整下载地址、验证清单与常见问题：
**[docs/openviking-embedding-setup.md](../docs/openviking-embedding-setup.md)**

> ⚠️ 注意 `Buffer.compare` 级别的细节：镜像对这个文件返回的 `ETag` 与真实内容 SHA256 **不一致**，
> 校验一律以本页列出的 SHA256 为准（该值由「镜像下载件」与「本机 `~/.cache` 件」两份独立算出并等同确认）。
