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
- [Download and install](#download-and-install)
- [Quick start](#quick-start)
- [Workflow](#workflow)
- [Design nodes](#design-nodes)
- [Model configuration](#model-configuration)
- [Attachments and Agent deliveries](#attachments-and-agent-deliveries)
- [Export Center](#export-center)
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
| **Persistent project shell** | A light, Codex-style desktop shell keeps project navigation available while the project hub handles search, sorting, creation, and opening. |
| **Opened nodes** | The sidebar shows only nodes opened for the current project. Add, switch, or close them freely; dirty drafts are protected by Save, Discard, and Cancel choices. |
| **12-node design path** | Move from project basics to the final document in dependency-aware stages. |
| **Central per-node Agent chat** | Each node has its own rule set, sessions, and context, with conversations, run state, and the composer in the center pane. |
| **Reviewable Agent deliveries** | Agent output is a validated `delivery` patch. Review the full result before saving it. |
| **Concurrency protection** | Node saves use revision/CAS. Only one mutating Agent task may run for a project node. |
| **Markdown working papers** | Edit, save, and track the state of every node directly. |
| **Project rule overrides** | Add project-specific instructions per node without changing bundled defaults. |
| **Local file pool** | Import TXT, Markdown, JSON, CSV, PDF, DOCX, and XLSX, then select files as Agent context. |
| **Local model settings** | OpenAI-compatible Chat Completions and Responses providers; one provider can hold multiple models with an explicit default, and every model requires an input context window. API keys are stored as plaintext in `~/.sion/providers.json` (restricted permissions) and never echoed in the UI. |
| **Per-session model choice** | Each session stores its own model and reasoning effort (off/low/medium/high); switching sessions or restarting restores it. |
| **Context and usage** | The circular indicator tracks the current session's complete visible history plus next-turn attachments, and separates current context occupancy from cumulative session input/output usage. It warns at 80% and rejects over-limit sends before persisting anything. |
| **One project container** | Choose a project directory once; Sion creates and discovers multiple projects inside it without prompting again. |
| **Right-side work tabs** | Draft, attachments, file previews, and Agent change previews use closable tabs. The pane is resizable and durable tabs restore after restart. |
| **Settings in one place** | Project-directory and model configuration live under Settings at bottom-left; there are no account, version, dark-theme, or browser controls. |
| **File preview** | The attachments tab previews extracted file text (text only); only checked files become Agent context. |
| **Structured Word export** | The Export Center runs a recoverable four-stage workflow (blueprint, formal draft, Word and QA, engineering attachments) that turns node content into a DOCX with heading levels, a table of contents, lists, and tables, plus structured review and native Save As. |

## Download and install

Prebuilt installers are on [GitHub Releases](https://github.com/ChesionSoft/Sion/releases).

Public builds are **unsigned development verification packages** (no Apple notarization / Windows code signing yet). After a browser download, macOS attaches a quarantine flag; Gatekeeper may block the first launch with “cannot verify the developer”, “is damaged and can’t be opened”, or a failed install prompt. That usually means the system rejected an unnotarized app, not a corrupt download.

### macOS: bypass Gatekeeper for unsigned builds

Public Release builds are **not notarized**. The dialog  
“Apple could not verify ‘Sion’ is free of malware” is expected, not a corrupt download.

Install first: download `Sion_*_universal.dmg` → open → drag **Sion** into **Applications**.  
Then try the methods below in order (most people succeed at option 2).

**Option 1: Clear quarantine on the app (DMG-only `xattr` is usually not enough)**

Browser downloads set `com.apple.quarantine`. Clearing it on the `.dmg` alone often does nothing; clear it on the installed **Sion.app**:

```bash
# Preferred: remove quarantine only
xattr -dr com.apple.quarantine /Applications/Sion.app

# Or strip all extended attributes
xattr -cr /Applications/Sion.app
```

If the app is not in Applications, use the real path, e.g. `~/Downloads/Sion.app`.

**Option 2 (recommended): System Settings → Open Anyway**

On recent macOS, Control-click may not offer Open for unnotarized apps:

1. Double-click **Sion** once (dismiss **Done** / **Cancel**; this records the block).
2. Open **System Settings → Privacy & Security**.
3. Scroll to **Security**.
4. You should see that Sion was blocked because it could not be checked for malware → **Open Anyway**.
5. Confirm with password / Watch / Touch ID.
6. Click **Open** again.

If **Open Anyway** is missing: double-click Sion once more, return to that page, or run option 1 first and repeat steps 1–6.

**Option 3: Control-click Open**

1. In Applications, select **Sion**.
2. **Control-click** (right-click / two-finger click) → **Open** (do not double-click).
3. If the dialog shows **Open**, confirm it.

**Option 4: Launch from Terminal**

```bash
xattr -dr com.apple.quarantine /Applications/Sion.app
open /Applications/Sion.app
```

Do not disable SIP or run `spctl --master-disable`.  
Removing this warning for all users requires Developer ID signing and notarization (see `RELEASE.md`).

### Windows

Run the NSIS installer (`.exe`). If SmartScreen shows “Windows protected your PC”, choose **More info** → **Run anyway**.

## Quick start

Developing Sion from source requires Node.js, Rust stable, and Tauri system prerequisites for the host platform. Run macOS builds on macOS and Windows installers on Windows.

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

1. Open **Settings** at the bottom-left and choose the directory that will contain projects (once). Return to the **Projects** hub to create a project; Sion gives every project its own folder.
2. Configure a provider and default model under **Settings → Models**. Offline editing works without one.
3. Open a project, then add or switch design nodes in the sidebar. The center pane is the current-node Agent conversation; the right-side **Draft**, **Attachments**, and file-preview tabs hold editable and reference material.
4. Chat with the current-node Agent, review its delivery patch, then explicitly apply it to the Markdown working paper.
5. In the **Export Center**, generate the blueprint, formal draft, and formal Word, run structured review and approvals, then export engineering attachments or Save As the Word after QA passes.

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

Add or edit a connection under **Settings → Models**:

| Field | What to enter |
|---|---|
| **Provider Name** | A UI label, such as `OpenAI`, `DeepSeek`, or `Qwen`. |
| **API Base URL** | The provider's **version root**, including its version prefix but not the final endpoint path. It commonly ends in `/v1`. |
| **Protocol** | Use **Chat Completions** for most OpenAI-compatible services. Use **Responses** only when the provider explicitly supports the OpenAI Responses API. |
| **Model list** | A provider can hold multiple models, each with a name, a context window, and one marked default. Model names must be unique (after trimming); exactly one model is the default. |
| **Context window** | Every usable model requires a positive integer input context window in tokens (for example `128000`). A model without a context window cannot be selected or sent. Sion never guesses a default. |
| **API Key** | A key issued by that provider. It is required for a new provider and is never echoed after saving. When editing an existing provider, leave this field blank to keep the stored key, or enter a new value to replace it. Keys are plaintext in `~/.sion/providers.json` with restricted file permissions. |

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

Each session stores its own model and reasoning effort (off, low, medium, high; new sessions default to medium). Switch model or reasoning effort at any time next to the conversation composer; the choice is saved to the current session and restored when you switch sessions or restart.

The circular indicator does not recalculate on every draft keystroke. It refreshes after session load, message completion, or changes to the model, rules, node, or next-turn attachments, using the same assembly path as a real run: protocol instructions, Agent rules, current node Markdown, every visible message in the current session, and selected next-turn attachments. Open it to see current context occupancy separately from cumulative input/output usage across completed model calls. Provider usage is exact when available and otherwise clearly marked estimated or mixed. Under 80% is ready, 80%–100% is a warning, and over 100% rejects the send before saving the user message, creating a run, or clearing the attachment selection, so no partial record is left behind. Sion sets no maximum output length and never auto-truncates prompt content.

An empty conversation offers four fill-only suggestions: “Summarize the information already in this section,” “List questions that still need confirmation,” “Add details from the reference material,” and “Check this section for omissions and suggest improvements.” A click fills the composer for editing; the user still presses Enter to submit. Run-history rows and per-turn status rows open the same centered **Run Details** dialog with timestamps, model information, context breakdown, usage, activity timeline, and delivery result. Older runs show “This information was not saved in the historical record” only where a field is unavailable while preserving the rest of the detail.

While an Agent is replying, **Agent is thinking** can be expanded to stream only the public reasoning summary explicitly supplied by the provider. Models that expose hidden reasoning only show execution state; hidden chain-of-thought is never displayed or persisted. Public summaries are capped at 2,000 Unicode characters and never enter project data as hidden-reasoning fields. Failed calls show a safely mapped, specific reason in both the conversation and Run Details; HTTP 504 means the provider's upstream gateway timed out. Sion does not retry automatically and adds no failed-run retry button.

> The desktop runtime has no browser search, browser automation, Playwright, or web-fetch subsystem. Agents work only from the current node, selected attachments, and the conversation.

## Attachments and Agent deliveries

Imported files are copied into the project's `files/` directory alongside extracted text. TXT, Markdown, JSON, CSV, PDF, DOCX, and XLSX are extractable. Failed extraction is visible as a failure; it is never presented as usable text. The right-hand attachments pane previews the extracted text of an imported file (text only; it never renders web pages or opens external links). Previewing a file is independent of selecting it as Agent context. Full text for files checked in the composer applies only to the next user message; a successful send clears the selection, while a validation failure keeps it for retry. Historical messages keep their attachment references, but later turns do not reinsert the full bodies of old attachments. Full file text is always read locally through Tauri and never enters the frontend.

Writeable Agent output must be fenced `delivery` JSON. By default it patches existing second-level sections only; a full rewrite requires an explicit user request. Sion validates the node structure, previews changes, and saves with the current revision, so a partial streaming response cannot become project content.

## Export Center

The Export Center is a recoverable four-stage local workflow that turns confirmed project nodes into final deliverables. Every artifact is persisted inside the project's `exports/` directory. There is no cloud sync, timed jobs, or export history.

- **Export blueprint**: a structured blueprint generated from the first eleven content nodes. It is preparation material, not a delivery artifact, and is shown separately at the top of the page. The blueprint must be approved before the formal draft can be generated.
- **Formal draft**: a deliverable PRD generated from the approved blueprint, validated structurally (one H1, a non-empty body under every H2, no TBD/TODO placeholders). The draft must be approved before the formal Word can be generated.
- **Formal Word and QA**: a DOCX generated deterministically from the approved draft, preserving heading levels, cover, table of contents, lists, and tables. It is structurally and content-QA'd before publishing; a failed QA deletes the candidate, keeps the previous passing Word, and marks it as based on an older draft. The formal Word can be copied externally through a native Save As.
- **Engineering attachments and completion**: after QA passes, `PROJECT_DESIGN.md`, `SPEC.md`, `TASKS.md`, and `AGENTS.md` are generated deterministically; the batch is complete only when all four are written.

The seven delivery artifacts are: the formal draft, the Word QA report, the formal Word, and the four engineering attachments. Regenerating an existing blueprint or draft never overwrites it directly: a candidate is generated and diffed first, then applied only after confirmation with revision-and-digest verification. Review is not chat: each instruction becomes a task whose result is a structured patch that must be selected and diffed before it is applied.

Markdown is previewed directly in app; DOCX is converted to sanitized content HTML with a notice that cover, TOC, headers, footers, and pagination must be checked in Word or WPS.

Source-node changes are advisory only: they never revoke approval or block generation, preview, or Save As. Editing the blueprint or draft, or applying a review patch, changes that artifact's digest and immediately revokes its approval; downstream files are kept and marked as based on an older version.

A model is used only to generate the blueprint, draft, and review proposals; approval, Word generation, QA, engineering attachments, and Save As never call a model. API keys are read only from `~/.sion/providers.json` and never enter project data, exports, logs, or run records; the model only receives the nodes, blueprint, or draft of the current project.

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

Pushing a `v*` tag (for example `v1.0.0`) triggers GitHub Actions to build a Universal macOS DMG and a Windows x64 NSIS installer and attach them to the GitHub Release. The default pipeline produces unsigned development verification packages; end-user installers still require platform code signing, and direct macOS distribution also requires Apple notarization. See [RELEASE.md](RELEASE.md) for the release checklist.
