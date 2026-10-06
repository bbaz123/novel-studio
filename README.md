<div align="center">

# Novel Studio

**A local-first AI writing studio that keeps a long novel consistent.**

Writing software + an AI writing assistant for **long-form fiction and Chinese web novels (网文)** — with a **foreshadowing tracker, character-state checks and a story bible** wired into every draft.

[![CI](https://github.com/bbaz123/novel-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/bbaz123/novel-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/node-%E2%89%A5%2022.13-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![npm dependencies: 0](https://img.shields.io/badge/npm%20dependencies-0-brightgreen)](package.json)
[![data: 100% local](https://img.shields.io/badge/data-100%25%20local-blue)](#-privacy--data)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

[**English**](README.md) · [简体中文](README.zh-CN.md)

<img src="assets/screenshot-writing.png" alt="Novel Studio writing desk: chapter tree on the left, rich-text editor in the middle, live story-reference panel on the right" width="100%">

</div>

> 📌 Version **v1.1.2** (experimental channel). The repository's **default branch `Experimental-Version-v1.0` is the current development line**; `refactor/p0-p6` keeps the previous release (v0.9.6) and `main` keeps the pre-refactor version (v0.9.3). Install steps and project layout follow this page: [Release v1.1.2](https://github.com/bbaz123/novel-studio/releases/tag/v1.1.2).

<details>
<summary><b>Contents</b></summary>

- [⭐ Features](#-features)
- [🎯 Why](#-why)
- [🧭 Where it fits](#-where-it-fits)
- [🚀 Quick Start](#-quick-start)
- [📦 Installation](#-installation)
- [💻 Usage](#-usage)
- [🖼 Screenshots](#-screenshots)
- [🏗 Architecture](#-architecture)
- [⚙️ Configuration](#️-configuration)
- [🔒 Privacy & Data](#-privacy--data)
- [🗺 Roadmap](#-roadmap)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)
- [🙏 Acknowledgements](#-acknowledgements)
- [📝 Changelog](#-changelog)

</details>

**Long fiction does not break at chapter 3 — it breaks at chapter 40.** A character is 「李队」 in ch. 12 and 「李队长」 in ch. 40; someone who died in ch. 3 walks back on stage; a thread you planted is never paid off. Chat tools write good paragraphs and lose the plot, and a longer prompt does not fix it.

Novel Studio turns those failures into **deterministic, inspectable gates** instead of hoping the prompt holds. It is self-hosted and privacy-first: a Node.js service on your own machine, your whole library in one SQLite file, and **zero npm dependencies** — no `npm install`, no account, no cloud, no subscription.

> **Runs fully offline, with no AI at all.** Manual writing, worldbuilding, outlining and export work out of the box and cost nothing. An LLM (DeepSeek or any OpenAI-compatible endpoint) is optional and only used for the features you switch on.

**Who it's for**

- **Web-novel and serial fiction authors** writing 100+ chapters who keep losing track of settings, character state and unpaid foreshadowing
- **Writers who want an AI assistant without handing over the manuscript** — everything stays in a local file you own
- **Developers and researchers** who want to script a writing pipeline: the UI is a thin client over a documented local HTTP API ([75 endpoints](harness-plugins/novel-writing/plugin.json))

**Who it's not for**

- **Not a SaaS** — no account, no cloud sync, no team collaboration, no subscription: it is an offline-capable app you own
- **Not a one-click book machine** — AI output is a draft or a proposal you approve, not an autopilot
- **Not a model vendor** — it ships no model and sells no tokens; bring your own API key and pay your own provider
- **Not an agent framework** — it is an application. The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) integration is optional and used only for the heavy creation pipeline

---

## ⭐ Features

**Consistency machinery — the reason this project exists**

- **Character consistency, enforced** — character sheets carry a profile, current state, relations and per-plotline state. The assembler feeds the right snapshot into each chapter, and the post-draft check flags anyone who acts against it.
- **A foreshadowing tracker with open/resolved state** — foreshadowing is a first-class kind in the event ledger, so a planted thread cannot quietly disappear. The model can query open threads, and they are marked resolved when the manuscript pays them off.
- **A story bible that stays wired into the draft** — glossary terms, world entries, character sheets, plotlines, long-term memory and the event ledger are assembled into context automatically, instead of being re-pasted by hand.
- **14-layer context assembly** — work → outline → long-term memory → semantic recall → event ledger → open foreshadowing → current scene → chapter blueprint → previous-text handoff → on-stage character cards → relations → world entries → glossary → writing redlines. Trimmed to a budget, and **everything trimmed stays retrievable** (every layer declares a `tool_hint`).
- **Zero-loss memory guardrail** — when long-term memory is compressed, every entity that has appeared in the manuscript (aliases included) must survive. Violations are **rejected at write time** and the missing names are returned.
- **Anti-AI-tone redlines** — deterministic regex scanning plus a positive style contract, shared by both the drafting and the reviewing path.
- **Post-draft consistency check** — after a chapter is generated, open foreshadowing, current character state, the event ledger, registered named entities and chapter boundaries are checked, and conflicts are reported as-is.
- **Story state kernel** — entities, timeline, foreshadowing, disclosure, knowledge, approval and style-quality state, exposed through a single contract.
- **Proposals, not auto-writes** — AI-extracted events and memories land as *proposals*; nothing is committed until you tick it. AI prose never overwrites a chapter without confirmation (the previous draft is archived automatically).

**The writing app around it**

- Multi-work library with a full **work → volume → chapter / scene** hierarchy
- Rich-text editor: autosave, live word count, bold/italic/underline/heading/quote/lists, 1/2/3-column layouts, manual version history
- **A worldbuilding tool built in** — plotlines, an outline mind-map, a glossary with categories and tags, character sheets (profile, current state, relations, per-plotline state) and long-term memory
- Link glossary terms inside the manuscript, with hover preview and click-through
- Global search across glossary, chapter text, characters and plotlines
- One-click import of the bundled demo novel《雾都缝匠》(*Mist Tailor*) — chapters, characters, glossary, long-term memory, event ledger and redlines included

**AI features — all optional**

- AI drafting / continuation, with a one-question-at-a-time clarification protocol before any paid call
- Polish, expand, beat-sheet and character-voice checks
- AI-generated plotlines, outlines, glossary entries, character sheets and memory drafts
- **AI create-a-novel** and a staged **creation pipeline** (worldbuilding → characters → outline → draft → consistency review)
- Per-task progress cards with plain-language stage text and a working cancel button
- **Runtime tracing** — record any UI action into a replayable call chain with token totals. It stores code locations, timings and sizes only — **never manuscript text or prompts**

## 🎯 Why

Chat-based tools write good paragraphs and lose the plot. Novel Studio targets the specific ways long fiction breaks, usually somewhere between chapter 20 and 80:

| Symptom | Chat-based tools | Novel Studio |
| --- | --- | --- |
| Setting drift — a character is 「李队」 in ch. 12 and 「李队长」 in ch. 40 | Longer prompts, or you remembering to remind it | **Deterministic checks**: pre-flight plus post-draft consistency review, conflicts listed one by one |
| A character who died in ch. 3 walks back on stage | You notice three chapters later | **Character state + event ledger** are assembled into context and checked against the new text |
| Foreshadowing is never paid off, or is spent as if it were already true | Nothing tracks it | **Foreshadowing ledger** with open/resolved state, surfaceable via `novel_foreshadows` |
| 「心中一凛」「眼中闪过一丝复杂」 on every page | Prompt-level pleading | **Redline rules + a positive style contract**, scanned deterministically |
| Re-pasting the setting bible into every conversation | Too little and it invents; too much and you blow the context | **Budget-trimmed 14-layer assembly**, with retrieval paths for whatever was trimmed |
| You cannot tell what the model actually saw, or where the money went | Guess, or read logs | **Inspectable**: `context_id`, per-layer provenance and per-call token accounting in the UI |
| Data and API keys live on someone else's server | The default for most tools | **Listens on `127.0.0.1` only**; everything is one SQLite file on your disk |

## 🧭 Where it fits

Choosing writing software is not a binary. These are the alternatives people actually evaluate, and where each one wins — Novel Studio is not trying to replace them all.

| If you want… | Reach for | Where Novel Studio differs |
| --- | --- | --- |
| A finished manuscript, professionally edited | [Sudowrite](https://www.sudowrite.com/), [Novelcrafter](https://www.novelcrafter.com/) | Those are hosted SaaS with stronger prose tooling; Novel Studio is self-hosted, free, and optimises for **continuity across 100+ chapters** rather than sentence-level polish |
| An offline, plain-text writing environment | [Obsidian](https://obsidian.md/) + Longform, [novelWriter](https://novelwriter.io/), [Manuskript](https://www.theologeek.ch/manuskript/) | Those are excellent file-based editors with no AI and no story state; Novel Studio keeps a **queryable story state** (character state, event ledger, foreshadowing) and can drive a model from it |
| A local LLM chat front-end | [SillyTavern](https://github.com/SillyTavern/SillyTavern), [KoboldAI](https://github.com/LostRuins/koboldcpp), [Open WebUI](https://github.com/open-webui/open-webui) | Those are conversation-first and deliberately stateless between scenes; Novel Studio is **manuscript-first**, with the model reading an assembled, budget-trimmed context |
| To build your own writing tool | Any Node.js HTTP client | Novel Studio's UI is a thin client over a local API — you can script the same kernel directly |

**The honest trade-off:** Novel Studio will not write a better *sentence* than a hosted AI writing service, and it will not give you a polished outline the way a human editor will. What it does that those tools do not is refuse to let setting drift, dead characters and unpaid foreshadowing pass silently — and it does that on your machine, for free.

## 🚀 Quick Start

> **Just want to write?** You need **Node.js only**. No `npm install`, no database, no network, no API key, no cost.

```bash
git clone https://github.com/bbaz123/novel-studio.git
cd novel-studio
npm start
```

Then open **<http://localhost:3737>**.

On Windows you can instead **double-click `start-novel-studio.cmd`** — it opens the service window and launches your browser for you.

First run — four things, about three minutes:

1. Click **✨ 一键导入示例小说《雾都缝匠》** (*Import demo novel*) on the home screen, then **打开** (*Open*) — this gives you a fully populated project so every screen makes sense immediately.
2. Browse **总览** (overview) → **正文写作** (writing) → **小说设定** (settings).
3. Create your own work with **新建作品** (*New work*).
4. Optionally connect an LLM — see [Configuration](#-configuration).

<img src="assets/screenshot-home.png" alt="Novel Studio home screen: the works library with the one-click demo-novel import" width="100%">

## 📦 Installation

| Requirement | Value | Notes |
| --- | --- | --- |
| OS | Windows / macOS / Linux | `start-novel-studio.cmd` is a Windows convenience; other platforms use `npm start` |
| Node.js | **22.13 or later** (24 LTS recommended) | Uses the built-in `node:sqlite` module. On 22.5-22.12 it still needs `--experimental-sqlite`, hence the 22.13 floor |
| Browser | Chrome / Edge / Firefox | Plain front-end, **no build step** |
| Disk | ~50 MB plus your library | Your database lives in `data/` |

```bash
node -v      # must print v22.13.0 or later
```

**Optional: connect an AI backend**

AI features need either a direct API config or a local DeepSeek Harness checkout. Both are configured in the app UI — no environment variables required.

- **Direct API** — `✨ AI 创作 → ⚙️ AI 设置`: set Base URL, API key and model. The key is stored only in your local SQLite database.
- **Creation kernel (DeepSeek Harness)** — `✨ AI 创作 → ⚙️ AI 设置 → 🛠 本地创作内核 (dsh)`: point it at a local `deepseek-harness` checkout, then install the bundled plugin:

```powershell
# Dry run first (writes nothing)
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Profile novel -DryRun

# Install / upgrade into the dedicated `novel` profile
powershell -ExecutionPolicy Bypass -File .\harness-plugins\novel-writing\install.ps1 -Profile novel
```

The plugin source lives in this repository at `harness-plugins/novel-writing/` and is mirrored to [bbaz123/novel-writing-plugin](https://github.com/bbaz123/novel-writing-plugin). It installs via a junction, so editing plugin code takes effect immediately — no reinstall.

**Upgrade / uninstall**

```bash
git pull && npm start        # upgrade; the database migrates automatically at startup
```

Uninstalling is "delete the folder": no installer, no registry entries, no background service. To keep the app but reset your library, stop the service and delete `data/` — it is recreated empty on the next start.

**Desktop shortcut (Windows, optional)**

```powershell
powershell -ExecutionPolicy Bypass -File .\create-desktop-shortcut.ps1
```


## 💻 Usage

**Daily writing.** Pick a chapter in the tree and write; saving is automatic. Switch to the three-column layout to keep the reference panel (glossary, characters, plotlines, and *what the AI will see*) beside you while you work.

**Writing with AI.** The toolbar's ✍️ **AI 写作** button opens a short requirement-confirmation dialog first — including a *just start* option — so a paid call never happens by accident. The model asks one question at a time until your intent is clear, then drafts. Generated events and memories arrive as proposals you accept or discard.

**HTTP API.** The UI is a thin client over a local HTTP API, so it can be scripted:

```bash
# Health check
curl http://localhost:3737/api/novel/ping

# Import the bundled demo novel (optional; the UI button does the same)
curl -X POST http://localhost:3737/api/demo/install \
  -H 'Content-Type: application/json' -d '{}'

# Assemble the creation context for a work (i.e. what the model would be given)
curl 'http://localhost:3737/api/novel/context?work_id=1'
```

> Write requests are restricted to same-origin local calls: the server validates `Origin` / `Host` and only listens on `127.0.0.1`, which also blocks DNS rebinding.

**Verification.** Everything below is zero-cost and never calls a real model:

```bash
# Offline suite (50 checks, no live instance, does not touch your data) — this is what CI runs
node scripts/ci-offline-checks.mjs

# Live-instance regression against a throwaway instance (temp data dir, OpenViking disabled)
node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs
node scripts/ci-isolated-run.mjs --port 3738 -- node harness-plugins/novel-writing/test/smoke.mjs

# Front-end execution test (runs public/app.js inside a minimal DOM stub)
node frontend-test.mjs

# Full acceptance sweep; checks needing your own data are reported as SKIPPED, not passed
node .p1-baseline/verify-all.mjs
```

CI (`.github/workflows/ci.yml`) runs the offline suite on Windows and Linux with Node 24, plus a Node 22.15 job that pins the dependency floor. **CI never calls a real model.**

## 🖼 Screenshots

| Writing desk | Characters and current state |
| --- | --- |
| ![Writing desk](assets/screenshot-writing.png) | ![Character sheets](assets/screenshot-settings-characters.png) |

| Work overview | Glossary and worldbuilding |
| --- | --- |
| ![Work overview](assets/screenshot-overview.png) | ![Glossary](assets/screenshot-settings-terms.png) |

<sub>All screenshots show the bundled demo novel《雾都缝匠》, captured from an isolated instance. `assets/preview.png` is the application icon, not a UI screenshot.</sub>

## 🏗 Architecture

```text
Your library (SQLite)
        |
        v
ai/context/layers.mjs      14 layer specs (+1 gated story-state layer): each declares source /
        |                  time perspective / knowledge scope / selection method / known gaps
        v
ai/context/assembler.mjs   The single assembler: trims to budget, and everything trimmed stays
        |                  retrievable (each layer carries a tool_hint)
        v
ai/context/integrity.mjs   Identity + integrity: context_id (content hash) and
        |                  context_request_id (this assembly). The manifest and the prompt must
        v                  match byte for byte; mismatches are recorded loudly, never dropped
harness.js -> dsh session  Model tier and reasoning effort have exactly one source (ai/policy.mjs)
        |
        v
draft / proposal           Events and memories become proposals until you approve them
        |
        v
ai/continuity-guard.mjs    Deterministic post-draft check: open foreshadowing, character state,
                           event ledger, named entities, chapter boundaries
```

```text
novel-studio/
├── public/                   # Front-end (no build step): index.html, styles.css, app.js
├── ai/
│   ├── policy.mjs            # Single source of truth for model tier + reasoning effort
│   ├── context/              # layers.mjs (layer specs) + assembler.mjs + integrity.mjs
│   ├── story-state/          # Story state kernel: entities, timeline, foreshadowing, approval...
│   ├── library/              # Cross-work reference library (scan -> confirm -> ingest)
│   └── continuity-guard.mjs  # Post-draft consistency checks
├── db.js                     # SQLite schema and migrations
├── server.js                 # HTTP server, API routes, creation-kernel endpoints
├── harness.js                # DeepSeek Harness bridge (mutual exclusion + CAS restore)
├── openviking*.js            # Optional shared-memory / semantic-recall backend
├── logger.js                 # Unified logging (SQLite + file, slow-op detection, retention)
├── debug-trace.js            # Runtime tracing engine (operation grouping, shape summaries)
├── harness-plugins/novel-writing/   # Bundled creation plugin (single source; mirror repo exists)
├── scripts/                  # CI entry points (offline checks, isolated runs)
├── .p1-baseline/             # Contract baselines and verification tooling
├── demo-data.json            # The bundled demo novel
└── data/                     # Your library and API keys (git-ignored)
```

Design docs live in [`docs/`](docs/README.md) — see [`docs/ai-core.md`](docs/ai-core.md) for the AI kernel and [`docs/context-contract.md`](docs/context-contract.md) for the context contract.


## ⚙️ Configuration

Everything user-facing is configured in the app. These environment variables exist for scripting and isolated instances:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3737` | Service port |
| `NOVELSTUDIO_DATA_DIR` | `./data` | Data directory (multi-instance / isolation) |
| `NOVELSTUDIO_DSH_REPO` | auto-detected | Path to a local DeepSeek Harness checkout (takes priority over the UI value) |
| `NOVELSTUDIO_DSH_PROFILE` | `novel` | dsh profile used for writing jobs |
| `NOVELSTUDIO_DSH_LAUNCH` | auto | Force the `source` or `built` launch path |
| `NOVELSTUDIO_CONTEXT_CACHE_TTL_MS` | 600000 | Context-assembly cache TTL |
| `NOVELSTUDIO_OV_DISABLED=1` | off | Disable the OpenViking integration entirely |
| `NOVELSTUDIO_OV_AUTOINDEX=0` | on | Skip index build at startup |
| `NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1` | off | Also reject entities that were merely *mentioned* but never on stage |
| `NOVELSTUDIO_COMPRESS_MIN_COVERAGE` | — | Memory-compression coverage floor (0-1) |
| `NOVELSTUDIO_TRACE_KEEP` | `20` | Recorded trace sessions to keep |
| `NOVELSTUDIO_TRACE_MAX_NODES` | `2000` | Max nodes captured per operation |
| `NOVELSTUDIO_TRACE_IDLE_MS` | `20000` | Stop tracing after the browser heartbeat is lost |

```bash
# Example: a different port and data directory (PowerShell)
$env:PORT=3738; $env:NOVELSTUDIO_DATA_DIR="D:\novel-data"; npm start

# macOS / Linux
PORT=3738 NOVELSTUDIO_DATA_DIR=/tmp/novel-data npm start
```

## 🔒 Privacy & Data

- Everything is stored locally in `novel-studio/data/novel.db`; logs live in `data/logs/` (14-day retention)
- **API keys are stored in that same local SQLite file** — never uploaded anywhere
- The server binds to `127.0.0.1`, and write requests validate `Origin` / `Host` to block DNS rebinding
- `data/` (including `data/backup-*` and `data/debug/`) is `.gitignore`d and never pushed
- Runtime traces contain code locations, timings and sizes only — **no manuscript text and no prompt text**
- Back up by stopping the service and copying the whole `data/` folder: the database runs in WAL mode, so copying only `novel.db` can miss recent writes

## 🗺 Roadmap

Only items that can be checked against the current repository are listed. The full backlog lives in [`docs/pending-decisions.md`](docs/pending-decisions.md).

- ~~Declare an open-source licence~~ → **MIT**
- ~~Add CI~~ → **Done**: `.github/workflows/ci.yml` (offline suite on Windows and Linux, a Node 22.15 floor job, and isolated live-instance jobs)
- **Cross-platform one-click launcher** — `start-novel-studio.cmd` is Windows-only today; macOS and Linux use `npm start`
- **Optional LAN access toggle** — the server intentionally binds to `127.0.0.1`; writing from a tablet requires editing `server.js`
- **More export formats** — whole-book TXT and Markdown plus single-chapter TXT are supported; EPUB and DOCX are not yet
- **Wire up the warm harness pool** (`ai/harness-pool.mjs`) after measuring the gain on the production path

## 🤝 Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — the essential rules are:

- **Questions, ideas and "how do I…"** — use [Discussions](https://github.com/bbaz123/novel-studio/discussions) rather than an issue
- **Bugs** — the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) asks for your Node version, OS, reproduction steps and the verbatim error
- **Open an issue before a large PR** so we can agree on direction first
- **No npm dependencies** — the project is deliberately zero-dependency, and PRs adding one will not be merged
- **Pure ESM** — `.mjs` plus `"type": "module"`; no CommonJS `require`
- **Never commit `data/`** — it contains your library and API keys
- **Run the gates before pushing**: `node .p1-baseline/verify-all.mjs`, `verify-phase-map.mjs` and `check-utf8.mjs`
- **Changing a threshold means adding an assertion** — thresholds and budgets are pinned by offline tests

Source comments are written in Chinese, explaining *why* rather than *what*. Documentation under `docs/` is Chinese-first; English summaries are being added incrementally.

## 📄 License

[MIT](LICENSE) © Novel Studio contributors.

Bundled third-party assets (for example `vendor/models/*.gguf`) remain under their upstream licences — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [`vendor/README.md`](vendor/README.md).

## 🙏 Acknowledgements

Built around [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for its AI capabilities. The in-app 「借鉴与致谢」 page lists every component and design reference actually used, together with its licence verification record.

## 📝 Changelog

Release history lives in [`docs/CHANGELOG.md`](docs/CHANGELOG.md). Current release: **v1.1.2** (experimental channel, branch `Experimental-Version-v1.0`) — the first anti-AI-flavour batch (P0). The generation chain no longer pads a chapter to a word quota or counts scenes per quota, the quality gate is strictly `pass / issues / unknown`, writing preferences now come from a single policy source (`ai/writing/` + `GET /api/ai/writing-policy`), and the plugin persona was updated to match (word count is a range, not a quota).
