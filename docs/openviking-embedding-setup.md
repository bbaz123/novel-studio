# OpenViking 记忆库与向量模型：完整下载地址 / 配置方法 / 本地内置说明

> 面向「想把这套语义记忆在**另一台机器**上复现」或「不想让 OpenViking 去外网下模型」的人。
> 本文只讲 **OpenViking 服务端 + 向量模型**这两件事。DeepSeek Harness（dsh）与工坊主体不在此文范围。
>
> **一句话结论**：工坊源码里已经带了模型（`vendor/models/bge-small-zh-v1.5-f16.gguf`，47.9 MB）。
> 你只需要装 OpenViking 服务端，再把它 `ov.conf` 的 `model_path` 指过来，**服务端就永远不会去外网下模型**。

---

## 一、三个东西分别在哪

| 组件 | 是什么 | 谁需要它 | 当前落点 |
|---|---|---|---|
| **向量模型** `bge-small-zh-v1.5-f16.gguf` | GGUF 格式的 512 维中文 dense embedding 模型，47,886,240 B | OpenViking 服务端（**工坊自己不加载模型**，只发 HTTP） | 源码内 `vendor/models/`；OpenViking 默认还会找 `~/.cache/openviking/models/` |
| **OpenViking 服务端** | Python 包（`openviking`），跑在 `127.0.0.1:1933` | 想用「语义召回」才需要；**不装不影响写作** | `uv tool install` 到 `~/.local/bin`，venv 在 `%APPDATA%\uv\tools\openviking` |
| **llama-cpp-python** | 加载 GGUF 的本地推理运行时 | 服务端用本地模型时**必需** | 同上（随 `uv tool install` 装进同一个 venv） |

工坊侧只需知道服务地址：`openviking.js` / `openviking-sync.js` 全部走 HTTP
（`/health`、`/api/v1/content/write`、`/api/v1/search/find`），全仓**没有任何一处**加载模型或 import Python。

---

## 二、下载地址（全部实测过，标注本机可达性）

### 2.1 向量模型（工坊源码里已带一份，以下用于补齐/核对）

| 用途 | 地址 | 本机实测 |
|---|---|---|
| **镜像（推荐）** | `https://hf-mirror.com/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf` | ✅ 200，41 MB 级，**1.1 秒** |
| 官网 | `https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true` | ❌ 握手超时（不可达） |
| 仓库页 | `https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf` | 页面可查，用于人工核对 |

**校验值（务必用这个，不要用镜像返回的 ETag）**

```text
文件名      bge-small-zh-v1.5-f16.gguf
字节数      47886240
SHA256      ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c
```

> ⚠️ 踩坑记录：镜像对同一个文件返回的 `ETag` 是 `e8e9f54b…21ed`，**与真实文件内容不符**。
> 我用「镜像下载件」与「本机 `~/.cache` 件」两份独立算 SHA256 并逐字节 `Buffer.compare` 比对（结果 identical），
> 才确认上述值。只信 SHA256。

**取回文件的两条路**

```powershell
# ① 源码里已经有：直接核对（不联网）
node scripts/fetch-embedding-model.mjs --verify-only

# ② 缺失时补齐（先试镜像，失败再试官网；中途写 .part 再改名，不会留下半截文件）
node scripts/fetch-embedding-model.mjs
```

失败时脚本会打印：两个地址各自的失败原因、期望字节数、期望 SHA256、以及手放位置 —— 不静默。

### 2.2 OpenViking 服务端

| 用途 | 地址 / 命令 | 本机实测 |
|---|---|---|
| 安装（官方推荐，本机就是这个渠道） | `uv tool install openviking --upgrade` | ✅ `uv 0.12.10` |
| 含本地 embedding 依赖的官方 extra | `uv tool install openviking --upgrade --with "openviking[local-embed]"` | 等价于下面那条 |
| 单独装推理运行时 | `uv tool install openviking --with "llama-cpp-python>=0.3.0"` | ✅ 本机就是这样装的 |
| PyPI 元数据 | `https://pypi.org/pypi/openviking/json` | ✅ 200，上游最新 **0.4.21**（本机 **0.4.17.1**） |
| PyPI 文件 CDN | `https://files.pythonhosted.org/packages/` | ✅ 200 |
| uv 本体 | `https://github.com/astral-sh/uv/releases/latest` ／ `https://pypi.org/pypi/uv/json` | ✅ 200 |
| llama-cpp-python | `https://pypi.org/pypi/llama-cpp-python/json` | ✅ 200 |
| 托管服务（不想自建） | `https://api.vikingdb.cn-beijing.volces.com/openviking` | 未实测 |
| 官方 CLI（可选） | `npm i -g @openviking/cli` ／ `https://registry.npmmirror.com/@openviking/cli/latest` | ✅ 200，最新 0.4.20 |
| dsh 记忆插件（让 GUI 会话也进同一个库） | `https://registry.npmmirror.com/@openviking/dsh-memory-plugin/latest` | ✅ 200，最新 **0.5.3**（本机装的是 0.3.0） |

> ℹ️ 服务端**不能**做成绿色便携包：`openviking.exe` 之类只有 46 KB，是 Python 入口壳，
> 真正要装的是 uv 管的 venv。所以它只能「按文档装」，不适合像模型那样塞进仓库。

---

## 三、配置方法

### 3.1 装好服务端并起服务

```bash
uv tool install openviking --upgrade --with "llama-cpp-python>=0.3.0"
openviking-server init        # 向导写 ~/.openviking/ov.conf
openviking-server doctor      # 体检：配置/模型/依赖是否就位
openviking-server             # 监听 127.0.0.1:1933
curl http://127.0.0.1:1933/health
# {"status":"ok","healthy":true,"version":"0.4.17.1","auth_mode":"dev"}
```

### 3.2 把模型指向源码里那一份（本文的重点）

`~/.openviking/ov.conf`：

```json
{
  "embedding": {
    "dense": {
      "provider": "local",
      "model": "bge-small-zh-v1.5-f16",
      "model_path": "C:/Users/a1941/Desktop/DeepSeek/novel-studio/vendor/models/bge-small-zh-v1.5-f16.gguf",
      "dimension": 512
    }
  },
  "vlm": {
    "provider": "openai",
    "api_base": "https://api.deepseek.com",
    "api_key": "<你的 DeepSeek API Key>",
    "model": "deepseek-v4-flash-vision-exp"
  }
}
```

改完**必须重启服务**（`ov.conf` 是启动配置，改运行时接口不会改写它）。

**字段说明（按本机 0.4.17.1 的实际代码核对，不是照文档抄）**

| 字段 | 取值 | 说明 |
|---|---|---|
| `provider` | `"local"` | 也可以用设计文档里写的 `backend` —— 两者都在 `EmbeddingModelConfig` 的字段表里，且内部互相同步（实测：只给 `backend: "local"` 也能得到 `provider='local'`）。示例统一用 `provider` |
| `model` | `"bge-small-zh-v1.5-f16"` | 逻辑名，决定默认下载地址与维度 |
| `model_path` | 绝对路径 | **给了它就不会联网下载**。解析顺序：`model_path` → 注册表 → 缓存目录 → 下载 |
| `dimension` | `512` | 该模型固定 512；写别的值会直接报 `has fixed dimension 512` |
| 其它字段名 | — | `extra: forbid` 生效：写错字段名会被 pydantic 拒绝（实测 `totally_unknown_field` → `Extra inputs are not permitted`） |

> 🔒 不想动全局文件：工坊的 `✨ AI 创作 → ⚙️ AI 设置 → 🧠 OpenViking 记忆库` 卡里填地址即可，
> 凭证优先级是「环境变量 → 界面填写 → `ovcli.conf` → `ov.conf` → 默认值」，卡上会如实标出当前这份来自哪一层。
> 但**模型路径不在这里配**，它属于服务端启动配置。

### 3.3 两个配置文件别混（本机现状）

| 文件 | 谁读 | 本机当前内容 |
|---|---|---|
| `~/.openviking/ov.conf` | **服务端**（启动配置：embedding / vlm / storage） | `embedding.dense` = local + `bge-small-zh-v1.5-f16` + 512；`vlm` = DeepSeek vision |
| `~/.openviking/ovcli.conf` | **客户端**（CLI / GUI / 工坊「写入全局配置」） | `{"url":"http://localhost:1933","api_key":null,"profile":false}` |

工坊的「写入全局配置（让 dsh 也用）」只改 `ovcli.conf` 的 `url` 与 `api_key` 两个字段，
写前自动备份、写后给还原方法 —— 它**不会**碰 `ov.conf`，所以不会影响模型路径。

---

## 四、验证清单（做完怎么确认真的对）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 模型文件与校验值 | `node scripts/fetch-embedding-model.mjs --verify-only` → 打印「已就绪并校验通过」 |
| 2 | 服务进程 | `curl http://127.0.0.1:1933/health` → `healthy: true` |
| 3 | **模型真的在用哪一份** | `curl http://127.0.0.1:1933/api/v1/observer/models` → Embedding Models 表里出现 `bge-small-zh-v1.5-f16 / local`，且 `Calls` 在涨 |
| 4 | 离线自证 | 断网后重启服务，若仍能起来并在第 3 步看到模型 → 证明用的是本地那份（走 `model_path`，没去下载） |
| 5 | 工坊侧连通 | 界面「OpenViking 记忆库」卡点「测试连接」；写作页参考面板「上下文」页签应出现语义召回命中 |

本次改动实际只做到第 1 步为止（**没有**重启你正在用的 OpenViking 服务，理由见文末「本次未验证的部分」）。

---

## 五、常见问题

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 服务起不来，报下载失败 | `model_path` 没配或路径写错，退了默认（要联网下载）而网络不通 | 核对 `model_path`；用第 4 节第 4 条离线自证 |
| 报 `has fixed dimension 512` | `dimension` 写成了别的值 | 改回 512 |
| 报 `Extra inputs are not permitted` | 字段名拼错（例如把 `provider` 写成 `provider_type`） | 按 3.2 的表逐字对照 |
| 报 collection 不兼容 / 要求 rebuild | `provider`/`model`/`dimension`/`model_path` 任一变化都会改写向量空间签名 | 明确重建索引（`allow_metadata_override` 只在维度不变时放行） |
| 工坊连上了、但 AI 写作召回不到 | 工坊读到的凭证与 dsh 侧不是同一份 | 在 OpenViking 卡上点「写入全局配置（让 dsh 也用）」 |
| 想彻底不用语义记忆 | — | 设 `NOVELSTUDIO_OV_DISABLED=1`，或直接不装服务；写作与装配完全不受影响 |

---

## 六、本次未验证的部分（如实记录）

1. **没有真的重启你的 OpenViking 服务**去加载 `model_path`。原因：1933 的生命周期由 `watchdog:3080` 托管，
   而当前 DSH Web（3080）正连着它；中断会波及正在进行的会话。**替代验证**（已执行，只读）：
   用你本机那套 venv 直接调 pydantic 与 `LocalDenseEmbedder`，确认配置被接受、且模型能从
   `vendor/models/` 那份加载并产出 512 维向量。
2. **官网地址不可达是本机网络现象**，不代表别的网络环境；镜像可用性也可能变化，所以脚本把两个地址都列了。
3. 上游 OpenViking 已到 **0.4.21**，本文的字段结论基于本机 **0.4.17.1**。跨版本升级后请重跑第 4 节第 3 步。
