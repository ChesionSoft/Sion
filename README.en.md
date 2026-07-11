<div align="center">

<img src="public/logo.png" alt="Sion logo" width="90" />



[中文](./README.md)

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)

</div>

> A local-first AI project design document workspace.
>
> For small outsourcing projects, solo builders, and lightweight teams. Organizes scattered requirements, reference files, per-node Agent conversations, and Markdown editing into a deliverable project design pipeline.

## Table of Contents

- [When to Use](#when-to-use)
- [Core Features](#core-features)
- [Quick Start](#quick-start)
- [Design Nodes](#design-nodes)
- [Model Configuration and Browser Search](#model-configuration-and-browser-search)
- [Export Artifacts](#export-artifacts)
- [Usage Tips](#usage-tips)
- [Local Data](#local-data)
- [User Guide](#user-guide)

## When to Use

- Starting a new project and need a project design document quickly.
- Scattered requirements, meeting notes, or client briefs need to be organized into structured sections.
- You want an Agent to help clarify, organize, and complete each design phase.
- You need to export a Word document and an AI development context bundle.
- You prefer keeping project data and model configuration on your local machine.

## Core Features

| Feature | Description |
|---------|-------------|
| **12-node design path** | Progress from project basics to final document generation, one node at a time. |
| **Per-node Agent chat** | Each node has its own rules, sessions, and context, focused on the current section. |
| **Model provider config** | Supports OpenAI-compatible Chat Completions and OpenAI Responses protocols with multiple providers and models. |
| **Reasoning effort** | Choose Low / Medium / High / Ultra reasoning effort per node. |
| **Project file pool** | Upload Markdown reference files and select them for the model to read during a chat. |
| **Browser search** | Configure browser search through a local safe proxy; no third-party search API key is required. |
| **Markdown deliverables** | Edit, preview, and save Markdown content for each node. |
| **Agent rule overrides** | Default rules are read-only; copy and customize per project. |
| **Staged export center** | Review a blueprint and formal draft; a server-side render gate must pass before the Word document is available. |

## Quick Start

```bash
# Requires Node.js 20.9 or later

# 1. Install dependencies
npm install

# 2. Start the dev server
npm run dev
```

Open:

```text
http://localhost:3000
```

Common check commands:

```bash
npm run test    # run tests
npm run lint    # run ESLint
npm run typecheck # check TypeScript types
npm run build   # production build
```

## Design Nodes

The project workbench organizes the design flow into 12 nodes:

| # | Node | Description |
|---|------|-------------|
| 1 | Project Basics | Project name, client, author, and other metadata. |
| 2 | Background & Goals | Project background, goals, and scope boundaries. |
| 3 | Users & Permissions | System users, roles, and permissions. |
| 4 | Business Process Design | Core business process descriptions. |
| 5 | Feature Module Design | Break down functional modules and sub-features. |
| 6 | Page & Interaction Design | Page structure, navigation, and key interactions. |
| 7 | Data Structure Design | Data models and key fields. |
| 8 | API Design | Server-side interfaces and request/response payloads. |
| 9 | Architecture & Deployment | Technology stack, deployment, and dependencies. |
| 10 | Development Task Breakdown | Turn the design into executable development tasks. |
| 11 | Open Items & Risks | Record assumptions, open questions, and risks. |
| 12 | Final Document Generation | Assemble and export the deliverables. |

## Model Configuration and Browser Search

Sion supports the OpenAI-compatible **Chat Completions** and **OpenAI Responses** protocols. Compatible providers include OpenAI, DeepSeek, Qwen, SiliconFlow, and similar services, subject to the protocol each provider actually supports.

In the main menu, open **Model Configuration** and add:

- **Provider Name**: A display name, e.g. `OpenAI`, `DeepSeek`.
- **API Protocol**: Choose Chat Completions or OpenAI Responses.
- **URL Mode**: Let Sion complete the endpoint from an API base URL, or enter the full endpoint supplied by the provider.
- **API Base URL / Full API URL**: Fill in the address that matches the selected URL mode.
- **API Key**: The key from your provider.
- **Model List**: Callable model names, e.g. `gpt-4.1`, `deepseek-chat`.
- **Tools**: Enable this for models with native function-tool calling. Sion uses a planner fallback when it is off; this setting does not decide whether web search can be enabled.
- **Default Model**: The preferred model.
- **Context Length**: Optional; helps you judge how much reference material the model can read.

Example: when using the base-URL mode, if provider documentation lists `https://api.example.com/v1/chat/completions`, enter:

```text
https://api.example.com
```

In base-URL mode, Chat Completions uses `/v1/chat/completions` and OpenAI Responses uses `/v1/responses`. Full-URL mode does not alter the URL you provide.

The landing page also contains **Browser Search** settings. Searches go through Sion's local safe proxy; choose Google or Baidu and a system Chrome/Edge browser or managed Chromium without configuring a third-party search API key. Managed Chromium is not downloaded automatically; install it explicitly from Settings.

Browser Search settings do not automatically enable web search in chats. Use the globe button in a chat input to enable **Web Search** for that session; the switch is saved per session. HTTP(S) URLs in a user message are also fetched automatically when possible.

## Export Artifacts

Open the **Export Center** from a project workbench. The formal PRD flow is gated in this order:

1. Generate and review `export-blueprint.md`, which selects the outward-facing content.
2. Approve the blueprint, then generate and review `formal-prd-draft.md`.
3. Approve the draft to generate Word and run server-side LibreOffice/Poppler render QA.
4. The DOCX is downloadable only after QA passes. On failure, use `formal-prd-qa-report.md` and regenerate the draft.

The project export directory can contain:

| File | Description |
|------|-------------|
| `export-blueprint.md` | PRD sections, sources, and inclusion choices for review. |
| `formal-prd-draft.md` | Formal outward-facing Markdown draft for review. |
| `formal-prd-qa-report.md` | DOCX render QA report; Word remains unavailable on failure. |
| `PROJECT_DESIGN.md` | Consolidated project design Markdown. |
| `项目开发设计文档.docx` | Formal Word deliverable that passed current render QA. |
| `SPEC.md` | Requirements and design context for AI coding tools. |
| `TASKS.md` | Development task breakdown. |
| `AGENTS.md` | Project rules context for AI coding agents. |

## Usage Tips

- In each node, let the Agent ask key questions first, then write confirmed content into the right-side deliverable.
- Keep uncertain information under **Design Assumptions** or **Open Questions**, not in confirmed content.
- Split large documents into Markdown files before sending them to the model, and select only the files needed for the current node to avoid context overflow.
- Use different models and reasoning efforts per node; architecture, API, and task breakdown often benefit from higher reasoning effort.
- If the default Agent rule does not fit a project, copy it as a project custom rule and adjust.

## Local Data

Sion is local-first by default. Project data is written under the repository working directory:

```text
projects/
  <project-id>/
    project.json
    nodes/
    chat/
    agent-overrides/
    files/
    exports/

settings/
  model-providers.json
  browser-search.json
```

These directories may contain client requirements, API keys, chat history, and exported documents. Do not commit them to a public repository.

## User Guide

For complete operating steps, see [USER_GUIDE.md](USER_GUIDE.md).
