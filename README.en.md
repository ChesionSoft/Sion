<div align="center">

<img src="public/logo.png" alt="Sion logo" width="90" />

[中文](./README.md)

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)

</div>

# Sion

A local-first AI project design-document desktop workspace. Built for small client projects, solo developers, and lightweight teams, Sion organizes scattered requirements, reference material, per-node Agent conversations, and Markdown working papers into a reviewable, deliverable project-design path.

Sion is built on Tauri 2: Rust owns project data, model connectivity, file extraction, and Word export; React/Vite provides the workbench UI. Supported platforms: macOS (Apple Silicon / Intel) and Windows x64.

## Contents

- [Core Capabilities](#core-capabilities)
- [Download and Install](#download-and-install)
- [Quick Start](#quick-start)
- [Workflow](#workflow)
- [Design Nodes](#design-nodes)
- [Model Configuration](#model-configuration)
- [Attachments and Agent Deliveries](#attachments-and-agent-deliveries)
- [Export Center](#export-center)
- [Local Data and Privacy](#local-data-and-privacy)
- [Build and Release](#build-and-release)

## Core Capabilities

| Capability | Description |
|---|---|
| **12-node design path** | Progress from project basics to the final document through 12 dependency-ordered nodes. |
| **Per-node Agent chat** | Each node has its own rules, sessions, and context; model and reasoning effort are selectable per session. |
| **Reviewable Agent deliveries** | Agent output is a validated `delivery` JSON patch, written only after preview and confirmation. |
| **Concurrency protection** | Node saves use revision/CAS; only one mutating Agent task may run per project node at a time. |
| **Markdown working papers** | Node content is directly editable and versioned. |
| **Project rule overrides** | Default Agent rules are bundled; per-project custom rules extend them without changing global defaults. |
| **Local file pool** | Import TXT / Markdown / JSON / CSV / PDF / DOCX / XLSX; extracted text can be selected as Agent context. |
| **Local model configuration** | OpenAI-compatible Chat Completions and OpenAI Responses protocols. See [Model Configuration](#model-configuration). |
| **Context and usage indicator** | The composer indicator measures context occupancy and cumulative session usage along the real run assembly path; warns at 80%, rejects sends over 100%. |
| **Structured Word export** | A four-stage Export Center produces DOCX with heading levels, TOC, lists, and tables. See [Export Center](#export-center). |
| **Single project container** | Choose a project directory once; Sion creates and discovers multiple projects inside it. |

## Download and Install

Prebuilt installers are available on [GitHub Releases](https://github.com/ChesionSoft/Sion/releases).

Current public builds are **unsigned development verification packages** (no Apple notarization / Windows code signing). The first launch may be blocked by the OS. Use one of the methods below.

### macOS

Download `Sion_*_universal.dmg`, open it, and drag **Sion** into **Applications**. The Gatekeeper warning "Apple cannot verify that Sion is free of malware" is expected. Unblock it with any of the following:

**Option 1: Clear the quarantine attribute** (on the installed app; clearing the DMG alone is insufficient)

```bash
xattr -dr com.apple.quarantine /Applications/Sion.app
```

**Option 2: Allow via System Settings**

1. Double-click **Sion** once (click **Done** on the block dialog to register the attempt).
2. Open **System Settings → Privacy & Security → Security**.
3. Find the Sion entry and click **Open Anyway**, then confirm.

**Option 3: Control-click Open**

In Applications, Control-click **Sion** → **Open**.

> Do not disable Gatekeeper globally with `spctl --master-disable` or disable SIP. Eliminating this warning entirely requires Developer ID signing and notarization; see [RELEASE.md](RELEASE.md).

### Windows

Download and run the NSIS installer (`.exe`). If SmartScreen shows "Windows protected your PC", choose **More info** → **Run anyway**.

## Quick Start

Development requirements: Node.js, Rust stable, and the Tauri system dependencies for the host platform. macOS apps must be built on macOS; Windows installers must be built on Windows.

```bash
npm install            # Install dependencies
npm run tauri dev      # Start the desktop app
```

Common checks:

```bash
npm run lint                 # TypeScript checks
npm run build                # Build the React/Vite workbench
npm run test:rust            # Tauri command-layer tests
cargo test --workspace       # Rust domain and storage tests
cargo clippy --workspace -- -D warnings
npm run test:no-browser-runtime
```

## Workflow

1. Choose a project directory in **Settings** (once); create projects from the **Projects** hub — Sion creates a dedicated folder per project.
2. Configure a provider and default model under **Settings → Models** (not required for offline editing).
3. Open a project and add or switch design nodes in the sidebar: the center pane hosts the node's Agent conversation, the right-side **Draft** tab edits Markdown, and the **Attachments** tab manages local files.
4. Chat with the current node's Agent, preview its delivery patch, and confirm to write it into the working paper.
5. In the **Export Center**, generate the blueprint, formal draft, and formal Word in sequence; after review and approval, export engineering attachments or save the Word externally.

## Design Nodes

| # | Node | Purpose |
|---:|---|---|
| 1 | Project Basics | Project name, client, author, and boundaries |
| 2 | Background & Goals | Background, objectives, and scope |
| 3 | Users & Permissions | Users, roles, permissions, and responsibilities |
| 4 | Business Process Design | Core business processes |
| 5 | Feature Module Design | Modules, sub-features, and business rules |
| 6 | Page & Interaction Design | Page inventory, navigation, and key interactions |
| 7 | Data Structure Design | Entities, fields, and data relationships |
| 8 | API Design | Service interfaces and request/response contracts |
| 9 | Architecture & Deployment | Tech stack, deployment plan, and dependencies |
| 10 | Development Task Breakdown | Executable development tasks |
| 11 | Open Items & Risks | Assumptions, risks, and pending questions |
| 12 | Final Document Generation | Section review and final Word export |

## Model Configuration

Supports the OpenAI-compatible **Chat Completions** and **OpenAI Responses** protocols; compatible providers include OpenAI, DeepSeek, Qwen, and SiliconFlow.

Configure under **Settings → Models**:

| Field | Description |
|---|---|
| **Provider Name** | UI label, e.g. `OpenAI`, `DeepSeek` |
| **API Base URL** | The provider's version root (includes the version prefix, excludes the endpoint path; typically ends with `/v1`) |
| **Protocol** | Chat Completions for most compatible services; Responses only when the provider explicitly supports it |
| **Model list** | Multiple models per provider, each with a name and context window; exactly one default |
| **Context window** | A positive-integer input context window (tokens) is required per model; models without one cannot be selected |
| **API Key** | Required for new providers; when editing, leave blank to keep the stored key or enter a new value to replace it. Never echoed in the UI after saving |

**Base URL rule**: Sion appends the endpoint path according to the selected protocol.

| Protocol | You enter | Actual request |
|---|---|---|
| Chat Completions | `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| Responses | `https://api.example.com/v1` | `https://api.example.com/v1/responses` |

Do not include `/chat/completions` or `/responses` in the Base URL, or the path will be duplicated. Use `http://` only for self-hosted services on localhost or a private network; production services should use `https://`.

Reference configurations:

| Provider | API Base URL | Protocol |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | Chat Completions / Responses |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions |
| Qwen (compatible mode) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Chat Completions |
| SiliconFlow | `https://api.siliconflow.cn/v1` | Chat Completions |

**Behavior notes**:

- Each session stores its own model and reasoning effort (off/low/medium/high; default medium), restored across session switches and restarts.
- The context indicator refreshes on session load, message completion, or changes to model/rules/attachments, using the same assembly path as a real run; sends exceeding the context window are rejected before any message is persisted.
- During a reply, only the provider-supplied public reasoning summary is streamed (capped at 2,000 characters); hidden chain-of-thought is neither displayed nor persisted.
- Models are used only for Agent runs and Export Center generation steps; Markdown editing, project management, and DOCX export work fully offline.

> The Sion desktop runtime contains no browser search, browser automation, or web-fetching subsystem. Agents operate solely on the current node, selected attachments, and conversation context.

## Attachments and Agent Deliveries

**Attachments**: Imported files are copied into the project's `files/` directory and managed together with their extracted text. Supported formats: TXT / Markdown / JSON / CSV / PDF / DOCX / XLSX; extraction failures are explicitly flagged. The attachments pane previews extracted text (plain text only; no web rendering). Previewing is independent of selecting a file as Agent context. The full text of checked files is injected only into the next user message and the selection is cleared after a successful send. File text is read locally through Tauri and never enters the frontend.

**Deliveries**: Agent write output must be a constrained fenced `delivery` JSON block — by default, section patches against existing second-level headings; full rewrites require an explicit user request. The application validates node structure, shows a change preview, and saves with the current revision, so incomplete streaming content can never be written into a project.

## Export Center

The Export Center is a recoverable four-stage local workflow that turns confirmed nodes into final deliverables. All artifacts are persisted in the project's `exports/` directory. There is no cloud sync or export history.

| Stage | Artifact | Description |
|---|---|---|
| 1. Export blueprint | Structured blueprint | Generated from the first 11 content nodes; must be approved before the draft |
| 2. Formal draft | Deliverable PRD body | Passes structural validation (single H1, non-empty body under every H2, no TBD/TODO placeholders); must be approved before Word generation |
| 3. Formal Word & QA | DOCX + QA report | Deterministically generated from the approved draft, preserving heading levels, cover, TOC, lists, and tables; on QA failure the previous passing Word is kept |
| 4. Engineering attachments | `PROJECT_DESIGN.md` / `SPEC.md` / `TASKS.md` / `AGENTS.md` | Deterministically generated after QA passes; complete only when all four are written |

Behavior rules:

- Regenerating an existing blueprint or draft produces a candidate with a diff first; replacement happens only after confirmation with revision-and-digest verification — never a direct overwrite.
- Manual edits or applied review patches revoke approval of the affected artifact; downstream artifacts are kept and marked as based on an older version. Source-node changes only raise advisory notices and do not revoke approvals.
- Review feedback is executed as tasks whose results are structured patches, applied item by item after diff preview.
- Models are called only to generate the blueprint, draft, and review proposals; approval, Word generation, QA, engineering attachments, and Save As require no model.

## Local Data and Privacy

Global configuration lives in `~/.sion/`; project data lives under the chosen project directory, one folder per project ID:

```text
~/.sion/
├── settings.json
├── providers.json      # Provider configuration and API keys (plaintext, restricted file permissions)
└── registry.json

<projects directory>/
└── <project id>/
    ├── project.json
    ├── nodes/          # Node working papers (CAS-versioned saves)
    ├── chat/           # Session records
    ├── files/          # Imported attachments and extracted text
    ├── agent-overrides/
    ├── exports/        # Export artifacts
    └── runs/           # Agent run records
```

Privacy constraints:

- API keys are stored only in `~/.sion/providers.json` and never enter project data, exports, logs, or IPC summaries.
- `~/.sion/` and the project directory may contain client material and must not be committed to public repositories.
- Models receive only the nodes, blueprint, or draft permitted within the current project.

## Build and Release

```bash
npm run build:desktop        # Current platform: build without bundling
npm run bundle:mac           # macOS: native-arch App and DMG
npm run bundle:mac-universal # macOS: Apple Silicon + Intel universal App/DMG
npm run bundle:windows       # Windows: NSIS and MSI installers
```

Pushing a `v*` tag (e.g. `v1.0.0`) triggers GitHub Actions: a universal macOS DMG and a Windows x64 NSIS installer are built and attached to the GitHub Release. The current pipeline produces unsigned development verification packages; production releases require platform code signing, and direct macOS distribution additionally requires Apple notarization. See [RELEASE.md](RELEASE.md).
