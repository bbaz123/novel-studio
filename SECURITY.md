# Security Policy

[**English**](#english) · [简体中文](#简体中文)

---

## English

### Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
[**Report a vulnerability**](https://github.com/bbaz123/novel-studio/security/advisories/new)
form (Security → Advisories → *Report a vulnerability*) instead.

Useful reports include:

- The affected version (`package.json` → `version`) or commit SHA
- Your OS and Node.js version
- Reproduction steps, and the smallest input that triggers the problem
- The impact you believe it has

We aim to acknowledge reports within **7 days** and to ship a fix or a documented
mitigation within **30 days** for confirmed issues. Credit is given in the release
notes unless you ask otherwise.

### Supported versions

| Version | Supported |
| --- | --- |
| Latest `v0.9.x` development line (the default branch) | ✅ |
| Older tags and the pre-refactor `main` | ❌ |

### Security model — read this before reporting

Novel Studio is a **local-first, single-user application**, and that shapes what
counts as a vulnerability. The following are **by design**, not bugs:

- The HTTP server binds to `127.0.0.1` only. There is no authentication, because
  there is no remote access.
- The app has no account system, no cloud sync and no telemetry endpoint.
- Your library, logs and **API keys** are stored unencrypted in a local SQLite
  database under `data/`. Anyone who can read that file can read your keys —
  protecting it is the operating system's job (disk encryption, user accounts).
- `data/` is `.gitignore`d. **Never commit it, and never paste a `novel.db` into
  an issue.**

Reports that *are* in scope include, for example: a way to reach the API from a
non-local origin (for example a DNS-rebinding bypass of the `Origin` / `Host`
checks), a path-traversal in the file-serving or import paths, argument or
template injection reaching a spawned `dsh` process, or a way to make the app
send your data to a third party without your configured provider.

### Handling your own secrets

- Treat `data/` as secret material. Back it up by stopping the service and
  copying the whole folder (the database uses WAL mode).
- Rotate any API key that has been exposed — in a screenshot, an issue, a log
  excerpt or a commit.
- If you believe a key was committed, rotate it first, then rewrite history.

---

## 简体中文

### 怎么报告安全问题

**请不要为安全问题开公开 issue。** 请使用 GitHub 的
[**私下报告漏洞**](https://github.com/bbaz123/novel-studio/security/advisories/new)
表单（仓库页 → Security → Advisories → *Report a vulnerability*）。

一份有用的报告应包含：

- 受影响的版本（`package.json` 的 `version`）或 commit SHA
- 你的操作系统与 Node.js 版本
- 复现步骤，以及能触发问题的最小输入
- 你认为的影响面

我们会在 **7 天内**确认收到，对确认存在的问题力争在 **30 天内**给出修复或明确的缓解说明。
除非你另有要求，发布说明里会为你署名。

### 支持的版本

| 版本 | 是否支持 |
| --- | --- |
| 最新 `v0.9.x` 开发线（当前默认分支） | ✅ |
| 更早的标签，以及重构前的 `main` | ❌ |

### 安全模型（报告前请先读这一节）

Novel Studio 是**本地优先、单人使用**的应用，"什么算漏洞"要放在这个前提下看。
下面这些是**设计如此**，不是缺陷：

- 服务只监听 `127.0.0.1`。**没有鉴权**，因为也没有远程访问。
- 没有账号体系、没有云同步、没有任何遥测上报端点。
- 作品、日志与 **API Key** 都以**未加密**形式存放在本机 `data/` 下的 SQLite 里。
  能读到该文件的人就能读到你的密钥——保护它靠操作系统（磁盘加密、用户账户隔离）。
- `data/` 已在 `.gitignore` 内。**不要提交它，也不要把 `novel.db` 贴进 issue。**

**属于受理范围**的报告例如：绕过 `Origin` / `Host` 校验从非本机来源访问 API（如
DNS rebinding）、文件服务或导入路径上的目录穿越、能把参数注入到被 spawn 的 `dsh`
子进程、或者能让应用在你未配置的服务商之外把数据发出去。

### 你自己的密钥

- 把 `data/` 当作机密材料。备份请**先停服务再整目录复制**（数据库是 WAL 模式）。
- 任何暴露过的 API Key 都要**轮换**——截图、issue、日志片段、提交都算暴露。
- 如果你怀疑某个 Key 已经被提交进仓库：**先轮换**，再去改历史。