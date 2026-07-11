<div align="center">

<img src="public/logo.png" alt="Sion logo" width="90" />


[English](./README.en.md)

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)

</div>

> 本地优先的 AI 项目设计文档工作台。
>
> 面向小型外包项目、个人开发者和轻量团队，把零散需求、补充资料、节点 Agent 对话和 Markdown 编辑组织成一条可交付的项目设计路径。

## 目录

- [适用场景](#适用场景)
- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [设计节点](#设计节点)
- [模型配置与浏览器搜索](#模型配置与浏览器搜索)
- [导出产物](#导出产物)
- [使用建议](#使用建议)
- [本地数据](#本地数据)
- [用户手册](#用户手册)

## 适用场景

- 接到新项目，需要快速产出《项目开发设计文档》。
- 已有零散需求、会议纪要或客户说明，需要整理成结构化章节。
- 希望每个设计阶段都有 Agent 协助追问、整理和补全。
- 希望最终导出 Word 文档和 AI 开发上下文包。
- 希望项目资料和模型配置保留在本地机器上。

## 核心能力

| 能力 | 说明 |
|------|------|
| **12 节点设计路径** | 从项目基本信息到最终文档生成，按节点逐步推进。 |
| **节点 Agent 对话** | 每个节点有独立规则、会话和上下文，围绕当前章节推进。 |
| **模型提供商配置** | 支持 OpenAI-compatible Chat Completions 与 OpenAI Responses 协议，可配置多个提供商和模型。 |
| **推理强度选择** | 在聊天框中选择低 / 中 / 高 / 超高推理强度，适配不同节点。 |
| **项目文件池** | 上传项目 Markdown 资料，对话时按需勾选给模型阅读。 |
| **浏览器搜索** | 通过本地安全代理配置并使用浏览器搜索能力，不需要第三方搜索 API Key。 |
| **Markdown 交付稿** | 每个节点都可编辑、预览和保存 Markdown 内容。 |
| **Agent 规则覆盖** | 默认规则只读；项目内可复制并保存自定义规则。 |
| **分阶段导出中心** | 审阅导出蓝图与正式正文，经过服务端渲染质检后才提供正式 Word。 |

## 快速开始

```bash
# 需要 Node.js 20.9 或更高版本

# 1. 安装依赖
npm install

# 2. 启动开发服务器
npm run dev
```

打开：

```text
http://localhost:3000
```

常用检查命令：

```bash
npm run test    # 运行测试
npm run lint    # 运行 ESLint
npm run typecheck # 检查 TypeScript 类型
npm run build   # 构建生产包
```

## 设计节点

项目工作台按 12 个节点组织设计流程：

| 序号 | 节点 | 说明 |
|------|------|------|
| 1 | 项目基本信息 | 记录项目名称、客户、编制方等元信息。 |
| 2 | 需求背景与建设目标 | 明确项目背景、目标和范围边界。 |
| 3 | 用户角色与权限 | 梳理系统用户、角色和权限。 |
| 4 | 业务流程设计 | 描述核心业务流程。 |
| 5 | 功能模块设计 | 拆分功能模块和子功能。 |
| 6 | 页面与交互设计 | 定义页面结构、导航和关键交互。 |
| 7 | 数据结构设计 | 设计数据模型和关键字段。 |
| 8 | 接口设计 | 定义服务端接口和出入参。 |
| 9 | 技术架构与部署 | 确定技术栈、部署和依赖。 |
| 10 | 开发任务拆分 | 将设计拆分为可执行开发任务。 |
| 11 | 待确认事项与风险 | 记录假设、待确认项和风险。 |
| 12 | 最终文档生成 | 汇总并导出生成物。 |

## 模型配置与浏览器搜索

Sion 支持 OpenAI-compatible **Chat Completions** 与 **OpenAI Responses** 协议。可配置 OpenAI、DeepSeek、通义千问、硅基流动等兼容服务；请以服务商实际支持的协议为准。

在主菜单的“模型配置”中添加：

- **提供商名称**：用于界面识别，例如 `OpenAI`、`DeepSeek`。
- **API 协议**：选择 Chat Completions 或 OpenAI Responses。
- **地址模式**：可让 Sion 从 API Base URL 补全路径，或直接填写服务商给出的完整 API URL。
- **API Base URL / 完整 API URL**：按所选地址模式填写。
- **API Key**：服务商提供的密钥。
- **模型列表**：可调用模型名称，例如 `gpt-4.1`、`deepseek-chat`。
- **默认模型**：设置后作为首选模型。
- **上下文长度**：可选，帮助你判断模型能读多长资料。

示例：若选择“由系统补全路径”，且服务商文档写的是 `https://api.example.com/v1/chat/completions`，则填写：

```text
https://api.example.com
```

主页还提供“浏览器搜索”设置。搜索通过本地安全代理发出；可以选择系统 Chrome/Edge 或托管 Chromium，并不会使用第三方搜索 API Key。

## 导出产物

从工作台进入“导出中心”后，正式 PRD 依次经过以下门禁：

1. 选择模型，生成并审阅 `export-blueprint.md`（对外内容选材）。
2. 确认蓝图后，生成并审阅 `formal-prd-draft.md`（正式正文）。
3. 确认正文后，生成 Word；服务端用 LibreOffice/Poppler 做渲染质检。
4. 仅当质检通过，`项目开发设计文档.docx` 才可下载；失败时查看 `formal-prd-qa-report.md` 并重新生成正文。

项目导出目录可能包含：

| 文件 | 说明 |
|------|------|
| `export-blueprint.md` | 正式 PRD 的章节、来源和纳入策略，供用户审阅。 |
| `formal-prd-draft.md` | 已按蓝图整理的对外正式正文，供用户审阅。 |
| `formal-prd-qa-report.md` | DOCX 渲染质检报告；未通过时 Word 不可下载。 |
| `PROJECT_DESIGN.md` | 汇总后的项目设计 Markdown。 |
| `项目开发设计文档.docx` | 通过当前渲染质检后的正式 Word 交付文档。 |
| `SPEC.md` | 适合 AI 开发工具读取的需求与设计上下文。 |
| `TASKS.md` | 开发任务拆分。 |
| `AGENTS.md` | 面向 AI coding agent 的项目规则上下文。 |

## 使用建议

- 每个节点先让 Agent 追问关键问题，再把确认内容写入右侧交付稿。
- 不确定的信息写入“设计假设”或“待确认问题”，不要混进已确认内容。
- 大文档进入模型前先拆成 Markdown，按需选择引用，避免上下文过长。
- 不同节点可以使用不同模型和推理强度；架构、接口、任务拆分适合更高推理强度。
- 如果默认 Agent 规则不适合某个项目，复制为项目自定义规则后再调整。

## 本地数据

Sion 是本地优先工具，项目数据默认写入仓库工作目录下：

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

这些目录包含项目内容、模型配置和可能的私密资料，默认不应提交到远端仓库。

## 用户手册

完整操作步骤见 [USER_GUIDE.md](USER_GUIDE.md)。
