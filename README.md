# Novel Studio

**Write chapter 100 without forgetting what happened in chapter 1.**

Novel Studio is an open-source, **local-first AI novel writing studio** for long-form fiction, serialized stories, and Chinese web novels (网文). It combines a chapter editor with a **story bible, character-state tracking, foreshadowing management, and continuity checks**—so you can find contradictions before they become plot holes.

**Local writing, optional AI, zero npm dependencies.** Built with Node.js and SQLite. No account, subscription, database server, or frontend build is required.

[![CI](https://github.com/bbaz123/novel-studio/actions/workflows/ci.yml/badge.svg?branch=Experimental-Version-v1.0)](https://github.com/bbaz123/novel-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](package.json)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-2ea44f)](package.json)

**English** · [简体中文](README.zh-CN.md) · [Getting started (中文)](docs/新手入门.md) · [Changelog](docs/CHANGELOG.md)

> **Development status:** This README describes the repository's default branch, `Experimental-Version-v1.0`. It is an experimental development line, not the older `main` branch. Check [`package.json`](package.json) and [Releases](https://github.com/bbaz123/novel-studio/releases) for version information.

## 🚀 Quick Start

**Try the writing studio without an API key.** You only need Node.js **22.13.0 or newer** (Node.js 24 recommended).

```bash
git clone https://github.com/bbaz123/novel-studio.git
cd novel-studio
npm start
```

Open **http://localhost:3737** in your browser. There is **no `npm install` step**.

On Windows, you can also download the repository and double-click `start-novel-studio.cmd`.

**Your first three minutes:**

1. On **我的作品** (My Works), import the bundled demo novel **《雾都缝匠》** and open it.
2. Explore **总览 → 正文写作 → 小说设定** (Overview → Writing → Story Settings).
3. Create your own work with **新建作品** (New Work). Add a volume and chapter, then start writing.
4. Connect an AI model later, if you want one. Manual editing, outlining, worldbuilding, and export do **not** require AI.

![Novel Studio writing desk with chapter navigation and rich-text editing](assets/screenshot-writing.png)

> Need step-by-step help? See the [Chinese first-run guide](docs/新手入门.md). For requirements and troubleshooting, see [Installation](#-installation).

## ⭐ Features

| Capability | What it does |
| --- | --- |
| **Long-form writing workspace** | Manage multiple works, volumes, chapters, and scenes; edit rich text with autosave, word counts, layouts, and version history. |
| **Character consistency** | Maintain character profiles, current state, relationships, and plotline-specific state; flag potential contradictions during review. |
| **Foreshadowing tracker** | Track planted threads in an event ledger, distinguish open from resolved leads, and retrieve loose ends before writing later chapters. |
| **Story bible & worldbuilding** | Keep outlines, plotlines, glossary entries, world settings, character sheets, and long-term story memory in one workspace. |
| **Context-aware AI assistance** | Assemble a budget-aware context from 14 base layers, with retrieval hints for content trimmed from the prompt. Semantic recall is optional. |
| **Review & revision safeguards** | Apply deterministic checks, surface review evidence, constrain targeted repairs, and keep author approval between suggestions and committed prose. |
| **Offline-first and scriptable** | Write without AI; optionally use OpenAI-compatible endpoints or DeepSeek Harness. A local HTTP API supports automation. |

AI suggestions are **not guaranteed to be correct**. A check can miss a contradiction or surface a false positive; the writer remains responsible for the manuscript.

## 🎯 Why Novel Studio?

A chat assistant may write a useful scene but cannot, by itself, be relied on to maintain the facts of a 100-chapter novel. Novel Studio makes story state **explicit and inspectable**.

| Common long-novel problem | Novel Studio's approach |
| --- | --- |
| A dead or missing character reappears without explanation | Record character state and events; include relevant state in chapter context and flag possible conflicts after drafting. |
| A foreshadowing thread is forgotten | Keep open and resolved leads in a queryable ledger. |
| Each new AI session needs the full story bible pasted again | Assemble chapter-relevant context with a bounded token budget and traceable sources. |
| An AI revision changes canon while fixing prose | Review findings, permitted edit scope, proposed changes, and author approval are separate steps. |
| The manuscript must stay on your computer | Store the library in local SQLite and run the app on `127.0.0.1` by default. |

**The distinction:** this is a **manuscript-first writing app**, not simply an LLM chat interface or a one-click novel generator.

### Who is it for?

- **Web-novel and serial-fiction authors** working across many chapters, characters, and plotlines.
- **Writers who care about local data ownership** and want AI to remain optional.
- **Developers and researchers** exploring structured story state, novel-writing workflows, and a local API.

It is **not** an online collaboration suite, a built-in cloud sync service, or a promise of publish-ready prose without human review.

### Where it fits

| If you mainly need… | Consider also… | Novel Studio's focus |
| --- | --- | --- |
| AI-assisted prose drafting | [Sudowrite](https://www.sudowrite.com/), [Novelcrafter](https://www.novelcrafter.com/) | A local story-state workflow with explicit continuity and approval gates. |
| A file-oriented writing environment | [novelWriter](https://novelwriter.io/), [Obsidian](https://obsidian.md/) | An integrated chapter editor plus structured characters, events, and foreshadowing. |
| An LLM conversation interface | [SillyTavern](https://github.com/SillyTavern/SillyTavern), [Open WebUI](https://github.com/open-webui/open-webui) | Chapter-centric authoring with a maintained story bible and post-draft checks. |

These tools serve overlapping but different workflows; no single tool is best for every writer.

## 🖼 Screenshots & Demo

The screenshots below use the included demo novel **《雾都缝匠》**, not a mock interface.

| Library and demo import | Writing desk |
| --- | --- |
| ![Library with example novel](assets/screenshot-home.png) | ![Chapter editor](assets/screenshot-writing.png) |

| Character sheets and current state | Glossary and worldbuilding |
| --- | --- |
| ![Character information and state](assets/screenshot-settings-characters.png) | ![Glossary and worldbuilding entries](assets/screenshot-settings-terms.png) |

After launching, use the home-screen demo import to explore populated chapters, characters, settings, memory, and events before creating your own project.

## 📦 Installation

| Requirement | Details |
| --- | --- |
| **Node.js** | **22.13.0+** for the application; **22.15.0+** for the complete verification toolchain; Node.js 24 recommended. |
| **Operating system** | Windows, macOS, or Linux. The Windows launcher is optional; macOS/Linux use `npm start`. CI exercises Windows and Linux, but platform-specific behavior may still differ. |
| **Browser** | A modern browser such as Chrome, Edge, or Firefox. |
| **Dependencies** | Zero third-party npm runtime packages. Node's built-in `node:sqlite` is used; no separate SQLite installation or frontend build. |

Check your installed version:

```bash
node -v
```

**Windows convenience launcher:** double-click `start-novel-studio.cmd`, or optionally create a shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File .\create-desktop-shortcut.ps1
```

**Updating:** stop the application, back up the entire `data/` folder, then pull updates on the branch you are using:

```bash
git pull
npm start
```

The application manages database migrations at startup, but a backup is still recommended before upgrades. To uninstall, stop the server and remove the application folder **after saving any data you want to keep**.

## 💻 Usage

### Write and manage a novel

Create a work, volume, and chapter. Write in the editor; content autosaves. Use the reference panel to look up people and world settings without leaving your draft. Maintain the **character state and event ledger** as the story develops.

### Draft with an AI model (optional)

Go to **✨ AI 创作 → ⚙️ AI 设置** and enter an OpenAI-compatible **Base URL**, **API Key**, and **model**. In the writing desk, use **✍️ AI 写作** to describe what you need before a model call. AI-generated facts and memories are proposed for review rather than silently becoming canon.

For the optional **DeepSeek Harness** creation pipeline, see [AI core documentation](docs/ai-core.md) and the included [`harness-plugins/novel-writing/`](harness-plugins/novel-writing/) integration. It requires additional setup; it is **not** needed for ordinary writing.

### Use the local HTTP API

With the server running, you can access its local API:

```bash
# Health check
curl http://localhost:3737/api/novel/ping

# Install the included example novel (also available through the UI)
curl -X POST http://localhost:3737/api/demo/install \
  -H 'Content-Type: application/json' \
  -d '{}'

# Inspect assembled story context; replace 1 with an existing work ID
curl 'http://localhost:3737/api/novel/context?work_id=1'
```

On Windows PowerShell, use `curl.exe` if `curl` is mapped to another command. Write endpoints are intended for local, same-origin access; do not expose this service directly to the public internet.

## 🏗 Architecture

```text
Browser UI (public/)
        |
        v
Local HTTP API (server.js) <----> SQLite (db.js, data/novel.db)
        |
        +--> Story state (characters / timeline / events / foreshadowing)
        |
        +--> Context assembler (14 base layers + gated story-state layer)
                     |
                     v
             Optional AI backend
                     |
                     v
             Draft / review / proposal
                     |
                     v
            Author approval & revision
```

| Location | Responsibility |
| --- | --- |
| `public/` | Browser UI; no frontend build step. |
| `server.js`, `db.js` | Local server, HTTP routes, schema, and database migrations. |
| `ai/context/` | Context layer definitions, assembly, budgets, and integrity metadata. |
| `ai/story-state/` | Structured story facts and state transitions. |
| `ai/continuity-guard.mjs` | Post-draft continuity checks. |
| `harness-plugins/novel-writing/` | Optional novel-creation integration. |
| `scripts/`, `tests/` | Offline and isolated verification. |

Technical references: [AI core](docs/ai-core.md) · [Context contract](docs/context-contract.md) · [Developer documentation index](docs/README.md).

## ⚙️ Configuration

Everyday AI settings are managed in the UI. These environment variables help with local scripting and isolated instances:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3737` | HTTP port. |
| `NOVELSTUDIO_DATA_DIR` | `./data` | Storage location for an isolated library. |
| `NOVELSTUDIO_DSH_REPO` | Auto-detected | Local DeepSeek Harness checkout path. |
| `NOVELSTUDIO_OV_DISABLED` | Not set | Set to `1` to disable the optional OpenViking integration. |
| `NOVELSTUDIO_TRACE_KEEP` | `20` | Number of runtime trace sessions retained. |

```bash
# macOS / Linux: change the port and data location
PORT=3738 NOVELSTUDIO_DATA_DIR=/tmp/novel-studio-data npm start
```

```powershell
# Windows PowerShell
$env:PORT=3738
$env:NOVELSTUDIO_DATA_DIR="D:\novel-studio-data"
npm start
```

## 🔒 Privacy, Data & Backups

- The app binds to **`127.0.0.1`** by default, and your library lives in **`data/novel.db`**.
- The `data/` directory may contain manuscripts, logs, and API credentials. It is git-ignored, but **must not be committed or shared**.
- **Manual writing works offline.** If you invoke a remote AI provider, the required request content—and authentication credentials—are sent to the provider you configured. Check that provider's policies before sending private work.
- To back up safely, **stop the app and copy the whole `data/` directory**. SQLite WAL mode means copying only `novel.db` may omit recent changes.
- No built-in cloud synchronization or multi-user hosting is provided.

For responsible vulnerability reporting, see [SECURITY.md](SECURITY.md).

## 🧪 Verification & Project Status

The core checks are designed to run **without contacting a paid model**. For the full verification toolchain, use Node.js 22.15.0+ (Node.js 24 recommended):

```bash
npm test

# Further project gates
node .p1-baseline/verify-phase-map.mjs
node .p1-baseline/check-utf8.mjs

# Live-instance API check against an isolated temporary instance
node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs
```

See [CI runs](https://github.com/bbaz123/novel-studio/actions/workflows/ci.yml), [verification status](docs/nsdsh/STATUS.md), and the [platform support matrix](docs/nsdsh/support-matrix.md). Check current runs rather than treating historic pass counts as evergreen guarantees.

This remains an **experimental project**. Not every optional runtime, platform combination, or model-quality scenario has been verified. Detection and model outputs still need editorial judgment.

## 🗺 Roadmap

Current development directions—not promises or scheduled releases—include:

- Easier one-click startup on macOS and Linux.
- More export formats (EPUB and DOCX are **not** currently supported as book exports).
- A carefully designed, optional local-network access mode.
- Continued evaluation of story-state, review/revision quality, and optional runtime performance.

Track actual decisions in [the project backlog](docs/pending-decisions.md) and [the changelog](docs/CHANGELOG.md).

## 🤝 Contributing

**Bug reports, documentation improvements, and pull requests are welcome.**

- **Found a reproducible bug?** [Open an issue](https://github.com/bbaz123/novel-studio/issues/new/choose) with your OS, Node version, reproduction steps, and relevant error output.
- **Have an idea or a question?** Start a [Discussion](https://github.com/bbaz123/novel-studio/discussions).
- **Want to contribute code?** Read [CONTRIBUTING.md](CONTRIBUTING.md) before a substantial change. The project intentionally maintains a zero-npm-dependency core and uses ESM.
- **Found a security issue?** Follow [the private reporting procedure](SECURITY.md), not a public issue.

If Novel Studio helps your writing or research, **star the repository** to make it easier for other writers and developers to discover. Feedback and useful forks are welcome, too.

## 📄 License & Acknowledgements

Novel Studio is available under the **[MIT License](LICENSE)**. Bundled third-party materials may have separate licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The optional AI creation integration uses [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). See the in-app acknowledgements and [technical documentation](docs/README.md) for implementation context.

---

**Build the story you want. Keep track of the story you've already told.**
