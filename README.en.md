<div align="center">

<img src="public/logo.png" alt="Sion logo" width="90" />

[中文](./README.md)

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)

</div>

> A local-first AI project design-document desktop workspace.
>
> Built for small client projects, solo builders, and lightweight teams. It turns scattered requirements, reference material, per-node Agent conversations, and Markdown deliverables into a reviewable project-design path.

Sion is a desktop application for macOS (Apple Silicon and Intel) and Windows x64. Rust owns project data, model connectivity, file extraction, and Word export; React/Vite provides the workbench UI.

## Contents

- [When to use Sion](#when-to-use-sion)
- [Core capabilities](#core-capabilities)
- [Quick start](#quick-start)
- [Workflow](#workflow)
- [Design nodes](#design-nodes)
- [Model configuration](#model-configuration)
- [Attachments and Agent deliveries](#attachments-and-agent-deliveries)
- [Word export](#word-export)
- [Local data and privacy](#local-data-and-privacy)
- [Build and release](#build-and-release)

## When to use Sion

- You need a project design document quickly for a new client project.
- Notes, client briefs, and existing files need to become structured design sections.
- You want an Agent to help clarify and draft every phase while a human keeps the final write decision.
- You need editable Markdown working papers and a structured Word deliverable.
- You want project material and model credentials to remain on the local machine, without browser search or automation services.

## Core capabilities

| Capability | Description |
|---|---|
| **12-node design path** | Move from project basics to the final document in dependency-aware stages. |
| **Per-node Agent chat** | Each node has its own rule set, sessions, and context. |
| **Reviewable Agent deliveries** | Agent output is a validated `delivery` patch. Review the full result before saving it. |
| **Concurrency protection** | Node saves use revision/CAS. Only one mutating Agent task may run for a project node. |
| **Markdown working papers** | Edit, save, and track the state of every node directly. |
| **Project rule overrides** | Add project-specific instructions per node without changing bundled defaults. |
| **Local file pool** | Import TXT, Markdown, JSON, CSV, PDF, DOCX, and XLSX, then select files as Agent context. |
| **Local model settings** | OpenAI-compatible Chat Completions and Responses providers; editable, with an explicit default. API keys are stored as plaintext in ~/.sion/providers.json (restricted permissions) and never echoed in the UI. |
| **One project container** | Choose a project directory once; Sion creates and discovers multiple projects inside it without prompting again. |
| **File preview** | The right-hand attachments pane previews extracted file text (text only); only checked files become Agent context. |
| **Structured Word export** | Export Markdown nodes as DOCX with headings, a table of contents, lists, and tables. |

## Quick start

Developing Sion requires Node.js, Rust stable, and Tauri system prerequisites for the host platform. Run macOS builds on macOS and Windows installers on Windows.

```bash
# 1. Install dependencies
npm install

# 2. Start the desktop app
npm run tauri dev
```

Useful checks:

```bash
npm run lint
npm run build
npm run test:rust
cargo test --workspace
cargo clippy --workspace -- -D warnings
npm run test:no-browser-runtime
```

## Workflow

1. In **Project Directory Settings** on the landing screen, choose a directory to hold your projects (you only do this once); then choose **Create Project** and Sion creates it as its own folder inside that directory.
2. Configure a provider and a default model in **Model Connection**. Offline editing works without one.
3. Work through the twelve nodes. Import files and select only the references relevant to the current Agent conversation. The workbench center has two tabs: **Chat** to talk with the node Agent and **Draft** to edit Markdown; the right-hand attachments pane previews extracted file text.
4. Chat with the current-node Agent, review its delivery patch, then explicitly apply it to the Markdown working paper.
5. Complete the final-node checks and export a DOCX through the system save dialog.

## Design nodes

| # | Node | Purpose |
|---:|---|---|
| 1 | Project Basics | Project name, client, author, and boundaries. |
| 2 | Background & Goals | Background, goals, and scope. |
| 3 | Users & Permissions | Users, roles, permissions, and responsibilities. |
| 4 | Business Process Design | Core business processes. |
| 5 | Feature Module Design | Modules, sub-features, and business rules. |
| 6 | Page & Interaction Design | Pages, navigation, and key interactions. |
| 7 | Data Structure Design | Entities, fields, and data relationships. |
| 8 | API Design | Service interfaces and request/response contracts. |
| 9 | Architecture & Deployment | Stack, deployment approach, and dependencies. |
| 10 | Development Task Breakdown | Executable implementation tasks. |
| 11 | Open Items & Risks | Assumptions, risks, and unresolved questions. |
| 12 | Final Document Generation | Final checks and Word export. |

## Model configuration

Sion supports OpenAI-compatible **Chat Completions** and **OpenAI Responses**. Configure OpenAI, DeepSeek, Qwen, SiliconFlow, or another compatible provider according to the API protocol and model IDs it actually exposes.

Complete every field in **Model Connection**:

| Field | What to enter |
|---|---|
| **Provider Name** | A UI label, such as `OpenAI`, `DeepSeek`, or `Qwen`. |
| **API Base URL** | The provider's **version root**, including its version prefix but not the final endpoint path. It commonly ends in `/v1`. |
| **Protocol** | Use **Chat Completions** for most OpenAI-compatible services. Use **Responses** only when the provider explicitly supports the OpenAI Responses API. |
| **Default Model** | The exact model ID in the provider documentation, for example `gpt-5` or `deepseek-chat`; it is not a marketing display name. |
| **API Key** | A key issued by that provider. It is required for a new provider and is never echoed after saving. When editing an existing provider, leave this field blank to keep the stored key, or enter a new value to replace it. Keys live only in the OS credential store and cannot be recovered. |

### How to enter the URL

The current UI uses **Base URL mode**. Sion appends the final path for the selected protocol:

| Protocol | You enter | Sion requests |
|---|---|---|
| Chat Completions | `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| Responses | `https://api.example.com/v1` | `https://api.example.com/v1/responses` |

For example, if a provider documents the full URL as `https://api.example.com/v1/chat/completions`, enter only:

```text
https://api.example.com/v1
```

Do not include `/chat/completions` or `/responses` in the Base URL: Sion would append it again. Use `http://` only for a compatible service you run locally or on a trusted private network; production services should use `https://`.

### Ready-to-adapt examples

These show endpoint and protocol shapes only. Available models, account access, and billing are determined by the provider.

| Provider | API Base URL | Protocol | Example default model |
|---|---|---|---|
| OpenAI (Chat) | `https://api.openai.com/v1` | Chat Completions | `gpt-5` |
| OpenAI (Responses) | `https://api.openai.com/v1` | Responses | `gpt-5` |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions | `deepseek-chat` |
| Qwen compatible mode | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Chat Completions | Use the model ID in your console |
| SiliconFlow | `https://api.siliconflow.cn/v1` | Chat Completions | Use the model ID in your console |

### Confirm the configuration

1. Select **Save Configuration**. Seeing the provider in the list with a configured state means its API key was saved to ~/.sion/providers.json.
2. Open or create a project and send an Agent message in any node. A streaming reply confirms the connection.
3. The first provider saved is the current default provider. In **Manage Model Connections** you can edit any provider's name, URL, protocol, or model without re-entering its API Key (leave the key blank to keep the stored secret), or enter a new key to replace it. Any provider can be set as the default. Deleting a provider also removes its record and API key from providers.json.

Common issues:

- **401 / unauthorized**: the API key is incorrect, lacks access, or belongs to a different service than the Base URL.
- **404 / missing endpoint**: the Base URL probably includes `/chat/completions` or `/responses`, or the selected protocol is wrong.
- **Model not found**: use the provider console's exact model ID in **Default Model**.
- **Can I work offline?** Yes. A model connection is needed only for Agent runs; Markdown editing, project creation, and DOCX export work offline.

Provider metadata and API keys are stored together in ~/.sion/providers.json (restricted permissions). The UI never echoes the key, and the key never enters project data, exports, or logs.

> The desktop runtime has no browser search, browser automation, Playwright, or web-fetch subsystem. Agents work only from the current node, selected attachments, and the conversation.

## Attachments and Agent deliveries

Imported files are copied into the project's `files/` directory alongside extracted text. TXT, Markdown, JSON, CSV, PDF, DOCX, and XLSX are extractable. Failed extraction is visible as a failure; it is never presented as usable text. The right-hand attachments pane previews the extracted text of an imported file (text only; it never renders web pages or opens external links). Previewing a file is independent of selecting it as Agent context; only checked files become Agent context.

Writeable Agent output must be fenced `delivery` JSON. By default it patches existing second-level sections only; a full rewrite requires an explicit user request. Sion validates the node structure, previews changes, and saves with the current revision, so a partial streaming response cannot become project content.

## Word export

Export DOCX from the final node and choose the destination through the native save dialog. The document preserves Markdown heading levels, project title and metadata, a table of contents, ordered and unordered lists, and pipe tables for continued review in Word.

The chosen destination receives the export. Sion does not automatically write it into the project directory or upload it.

## Local data and privacy

Global configuration lives in `~/.sion/`; project data lives under the project directory you choose, one folder per project ID:

```text
~/.sion/
├── settings.json
├── providers.json
└── registry.json

<projects directory>/
└── <project id>/
    ├── project.json
    ├── nodes/
    ├── chat/
    ├── files/
    ├── agent-overrides/
    ├── exports/
    └── runs/
```

The project directory is chosen once; Sion creates and discovers multiple projects inside it. Project content, attachments, chat history, and exports can contain client information and should not be committed to a public repository. The settings, registry, and providers.json (which contains API keys) under `~/.sion/` should not be committed either.

## Build and release

```bash
npm run build:desktop        # Build current platform without bundling
npm run bundle:mac           # macOS: native-architecture app and DMG
npm run bundle:mac-universal # macOS: Apple Silicon + Intel universal app and DMG
npm run bundle:windows       # Windows: NSIS and MSI installers
```

GitHub Actions validates and packages on Apple Silicon, Intel macOS, and Windows x64 runners. End-user installers require platform code signing; direct macOS distribution also requires Apple notarization. See [RELEASE.md](RELEASE.md) for the release checklist.
