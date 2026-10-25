# 导出格式、发布与多书工作区（2026-10-25）

对应上一轮遗留的三条边界：DOCX/PDF/EPUB 全标 UNSUPPORTED、发布只有拒绝路径、一本书一个 root。
本次按作者决定落地：**PDF 接受本机 Edge 无头打印**；**发布目的地 = 本地目录**。

## 1. 四种导出格式

| 格式 | 实现 | 依赖 | 校验 |
| --- | --- | --- | --- |
| Markdown | `core.buildMarkdown` | 无 | 内容 hash |
| DOCX | `export/docx.mjs`（最小 WordprocessingML） | 无（自写 ZIP） | ZIP 测试通过 + 四个 OOXML 部件齐全 |
| EPUB | `export/epub.mjs`（EPUB 2.0） | 无（自写 ZIP） | ZIP 测试通过 + `mimetype` 首条且 `compress_type=0` |
| PDF | `export/pdf.mjs`（Edge 无头打印） | 本机 Edge（已实测） | `%PDF-` 头 + 文件大小稳定 |

- ZIP 写入器：`export/zip.mjs`（deflateRaw + CRC32，不支持 ZIP64，超限报错）。
- 每种产物在 `manifest/deliverable-manifest.json` 记 `kind / sha256 / producer / tool_version`。
- **PDF 缺 Edge 时**：`unsupported: ["pdf"]`，不生成空文件；有 Edge 但渲染失败 → 真实错误（不降级）。
- 实测（4 章书）：`book.md 1249B / book.docx 2216B / book.epub 3593B / book.pdf 56563B`。
- 结构校验（python `zipfile`）：docx `testzip=None`、部件 `[Content_Types].xml / _rels/.rels / word/document.xml / docProps/core.xml`；
  epub `testzip=None`、首条 `mimetype compress_type=0`、4 个章节 XHTML 齐全。
  **没有做视觉验收**；本机 `python-docx` 因 lxml 环境问题无法导入，因此没有用它当判据（不拿跑不起来的检查冒充通过）。

### 踩过的坑（已修，防回退）

1. **Edge 退出码 0 但 PDF 还没落盘**：必须同步轮询文件大小稳定（`Atomics.wait` 实现 sleep），立刻 stat 会误报“未产出”。
2. **相对路径会被 Edge 静默丢弃**（退出码 0 没文件）：`workDir` 与 `--print-to-pdf` 必须绝对路径，HTML 用 `pathToFileURL`。
3. **`msedge --version` 在中文系统返回本地化提示而非版本号**：不编造版本，退回文件指纹（`file-mtime + size`）写入 `tool_version`。

## 2. 发布（本地目录适配器）

`publishJob({root, approvals:{publish:true, publish_hash}, dest?})`：

1. `publish !== true` → `PUBLISH_DISABLED`（403）；
2. 缺 `publish_hash` → `PUBLISH_HASH_REQUIRED`（400）；
3. `publish_hash` ≠ 交付物根 hash（`path:sha256` 排序后 sha256）→ `PUBLISH_HASH_MISMATCH`（409）；
4. 通过后：复制 `export/*` 到目标目录（默认 `book-project/publish/<时间戳>`，可用 `NOVELSTUDIO_PUBLISH_DIR` 或 `dest` 指定），写 `publish-manifest.json`（审批 hash + 每个文件 sha256），并在 `.job/publish-audit.json` 留审计。

HTTP：`POST /api/one-click-book/publish {publish:true, hash, dest?}`；状态里 `deliverable_hash` 供 UI/CLI 取用。
实测：无审批 403 → 错 hash 409 → 对 hash 成功复制 4 个文件并写清单。

**仍然没有的**：GitHub release / 远端上传适配器（未授权）。目的地只有本地目录；未来加适配器必须走同一套 hash 绑定。

## 3. 多书工作区

`books/<book_id>/` 下每本都是**标准书根**（内部路径与门禁零改动），由此锁天然变成书级锁：

- 环境变量 `NOVELSTUDIO_OCB_BOOKS_DIR` 开启；
- `GET /api/one-click-book/books` 列表（status/chapters/committed/updated_at）；
- `POST /api/one-click-book/books {book_id}` 建书（`book_id` 白名单 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，`../` 被拒）；
- 其余端点全部支持 `/books/:id/...`，与单书共用同一套逻辑；
- CLI：`--books-dir <dir> --book <id>`；发布：`--publish --publish-dir <dir>`。

实测：两本书分别 `book-a`（停在 EXEMPLAR_REVIEW）与 `book-b`（COMPLETED）互不阻塞；非法 id 返回 `INVALID_BOOK_ID`。

## 4. 依旧保持的边界（未变）

- 第三方时间戳（RFC3161/OpenTimestamps）仍 `UNSUPPORTED`；外部锚目前是 Ed25519 本地签名 + git 仓库锚。
- 发布不覆盖远端；未授权前不会做任何上传。
- docx/pdf/epub 的渲染结果随工具版本变化，已把 `tool_version` 写入清单，便于复核。

## 验证

```
node scripts/test-one-click-book.mjs      → passed=34 failed=0
node scripts/one-click-book-mutation.mjs  → killed=12/12 score=1.0
node scripts/one-click-book-finalize.mjs  → ok=true gates=true ledger=true formats=true recovery=true
```
