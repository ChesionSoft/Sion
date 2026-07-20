<div align="center">

<img src="public/logo.png" alt="Sion logo" width="90" />

[English](./README.en.md)

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)

</div>

# Sion

本地优先的 AI 项目设计文档桌面工作台。面向小型外包项目、个人开发者和轻量团队，将零散需求、参考资料、节点 Agent 对话和 Markdown 工作稿组织为一条可审阅、可交付的项目设计路径。

Sion 基于 Tauri 2：Rust 负责项目数据、模型连接、文件提取与 Word 导出，React/Vite 仅提供工作台界面。支持 macOS（Apple Silicon / Intel）与 Windows x64。

## 目录

- [核心能力](#核心能力)
- [下载与安装](#下载与安装)
- [快速开始](#快速开始)
- [使用流程](#使用流程)
- [设计节点](#设计节点)
- [模型配置](#模型配置)
- [附件与 Agent 交付](#附件与-agent-交付)
- [导出中心](#导出中心)
- [本地数据与隐私](#本地数据与隐私)
- [构建与发布](#构建与发布)

## 核心能力

| 能力 | 说明 |
|---|---|
| **12 节点设计路径** | 从项目基本信息到最终文档，按依赖关系分 12 个节点逐步推进。 |
| **节点 Agent 对话** | 每个节点拥有独立规则、会话与上下文；支持会话级模型与推理强度选择。 |
| **可审阅的 Agent 交付** | Agent 输出为受校验的 `delivery` JSON 补丁，预览确认后才写入工作稿。 |
| **并发保护** | 节点保存采用 revision/CAS；同一项目节点同时只允许一个修改性 Agent 任务。 |
| **Markdown 工作稿** | 节点内容可直接编辑、保存，保留版本状态。 |
| **项目级规则覆盖** | 默认 Agent 规则内置于应用；可为单个项目追加自定义规则，不影响全局默认值。 |
| **本地文件池** | 导入 TXT / Markdown / JSON / CSV / PDF / DOCX / XLSX，提取文本后可勾选为 Agent 上下文。 |
| **本地模型配置** | 支持 OpenAI-compatible Chat Completions 与 OpenAI Responses 协议，详见[模型配置](#模型配置)。 |
| **上下文与用量指示** | 输入框旁的指示器按真实运行拼装路径统计上下文占用与会话累计用量；80% 起警告，超过 100% 时拒绝发送。 |
| **结构化 Word 导出** | 四阶段导出中心将节点内容整理为含标题层级、目录、列表和表格的 DOCX，详见[导出中心](#导出中心)。 |
| **统一项目目录** | 项目目录只需选择一次，Sion 在其中自动创建并发现多个项目。 |

## 下载与安装

预编译安装包见 [GitHub Releases](https://github.com/ChesionSoft/Sion/releases)。

当前公开发布为**未签名开发验证包**（未做 Apple 公证 / Windows 代码签名），首次打开可能被系统拦截。以下为放行方式。

### macOS

下载 `Sion_*_universal.dmg`，打开后将 **Sion** 拖入 **应用程序**。Gatekeeper 提示「无法验证是否包含恶意软件」属预期行为，任选一种方式放行：

**方式一：清除隔离属性**（对已安装的 App 执行，只清 DMG 无效）

```bash
xattr -dr com.apple.quarantine /Applications/Sion.app
```

**方式二：系统设置放行**

1. 双击一次 **Sion**（弹出拦截提示时点 **完成**，留下拦截记录）。
2. 打开 **系统设置 → 隐私与安全性 → 安全性**。
3. 找到 Sion 的拦截记录，点 **仍要打开** 并确认。

**方式三：Control 单击打开**

在「应用程序」中按住 Control 单击 **Sion** → **打开**。

> 请勿通过 `spctl --master-disable` 全局关闭 Gatekeeper 或关闭 SIP。彻底消除该提示需 Apple Developer 签名并公证，见 [RELEASE.md](RELEASE.md)。

### Windows

下载并运行 NSIS 安装器（`.exe`）。SmartScreen 提示「Windows 已保护你的电脑」时，点 **更多信息** → **仍要运行**。

## 快速开始

开发环境依赖：Node.js、Rust stable，以及当前平台的 Tauri 系统依赖。macOS 应用须在 macOS 上构建，Windows 安装器须在 Windows 上构建。

```bash
npm install            # 安装依赖
npm run tauri dev      # 启动桌面应用
```

常用检查命令：

```bash
npm run lint                 # TypeScript 检查
npm run build                # 构建 React/Vite 工作台
npm run test:rust            # Tauri 命令层测试
cargo test --workspace       # Rust 领域与存储层测试
cargo clippy --workspace -- -D warnings
npm run test:no-browser-runtime
```

## 使用流程

1. 在「设置」中选择项目目录（仅需一次）；在「项目」首页创建项目，Sion 会在该目录下为每个项目建立独立文件夹。
2. 在「设置 → 模型」中配置提供商与默认模型（离线编辑不需要模型配置）。
3. 打开项目，在左侧添加或切换设计节点：中央为节点 Agent 对话，右侧「交付稿」分页编辑 Markdown，「资料」分页管理本地附件。
4. 与当前节点的 Agent 对话，预览交付补丁，确认后写入工作稿。
5. 在「导出中心」依次生成蓝图、正式正文与正式 Word，评审批准后导出工程附件或另存 Word。

## 设计节点

| 序号 | 节点 | 说明 |
|---:|---|---|
| 1 | 项目基本信息 | 项目名称、客户、编制方和项目边界 |
| 2 | 需求背景与建设目标 | 项目背景、建设目标和范围边界 |
| 3 | 用户角色与权限 | 用户、角色、权限和职责 |
| 4 | 业务流程设计 | 核心业务流程 |
| 5 | 功能模块设计 | 功能模块、子功能和业务规则 |
| 6 | 页面与交互设计 | 页面清单、导航和关键交互 |
| 7 | 数据结构设计 | 实体、字段和数据关系 |
| 8 | 接口设计 | 服务接口与请求/响应约定 |
| 9 | 技术架构与部署 | 技术栈、部署方案和依赖 |
| 10 | 开发任务拆分 | 可执行的开发任务 |
| 11 | 待确认事项与风险 | 假设、风险和待确认问题 |
| 12 | 最终文档生成 | 章节检查与最终 Word 导出 |

## 模型配置

支持 OpenAI-compatible **Chat Completions** 与 **OpenAI Responses** 两种协议，可接入 OpenAI、DeepSeek、通义千问、硅基流动等兼容服务。

在「设置 → 模型」中配置：

| 字段 | 说明 |
|---|---|
| **提供商名称** | 界面显示用标签，如 `OpenAI`、`DeepSeek` |
| **API Base URL** | 服务商版本根地址（含版本前缀、不含接口路径，通常以 `/v1` 结尾） |
| **协议** | 多数兼容服务选 Chat Completions；仅服务商明确支持时选 Responses |
| **模型列表** | 一个提供商可配置多个模型，各填名称与上下文窗口，指定唯一默认模型 |
| **上下文窗口** | 每个模型必须填写正整数输入上下文窗口（tokens），未填写的模型不可选用 |
| **API Key** | 新提供商必填；编辑时留空保留原密钥，填入新值则替换。保存后界面不回显 |

**Base URL 规则**：Sion 按协议自动补全接口路径。

| 协议 | 填写 | 实际请求 |
|---|---|---|
| Chat Completions | `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| Responses | `https://api.example.com/v1` | `https://api.example.com/v1/responses` |

不要在 Base URL 中包含 `/chat/completions` 或 `/responses`，否则路径会被重复拼接。`http://` 仅用于本机或内网自建服务，生产服务应使用 `https://`。

参考配置：

| 提供商 | API Base URL | 协议 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | Chat Completions / Responses |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions |
| 通义千问（兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Chat Completions |
| 硅基流动 | `https://api.siliconflow.cn/v1` | Chat Completions |

**行为说明**：

- 每个会话独立保存所选模型与推理强度（关闭/低/中/高，默认中），切换会话或重启后恢复。
- 上下文指示器在会话加载、消息完成或模型/规则/资料变化后刷新，统计口径与真实运行一致；超过上下文窗口时，在写入任何消息前拒绝发送。
- Agent 回复期间仅流式展示服务商提供的公开推理摘要（上限 2,000 字符），不显示、不保存隐藏思维链。
- 模型仅用于 Agent 运行与导出中心的生成步骤；Markdown 编辑、项目管理和 DOCX 导出均可离线完成。

> Sion 桌面运行时不包含浏览器搜索、浏览器自动化或网页抓取子系统。Agent 只基于当前节点、已勾选附件和会话上下文工作。

## 附件与 Agent 交付

**附件**：导入的文件复制进项目 `files/` 目录，与提取文本一并管理。支持 TXT / Markdown / JSON / CSV / PDF / DOCX / XLSX；提取失败会明确标记。右侧资料面板可预览提取文本（纯文本，不渲染网页）；预览与是否勾选为 Agent 上下文相互独立。勾选文件的全文仅注入下一条用户消息，发送成功后自动清除勾选。文件全文只在本机经 Tauri 读取，不进入前端。

**交付**：Agent 的写入内容必须是受约束的 fenced `delivery` JSON——默认只提交已有二级章节的分节补丁，完整重写须由用户明确要求。应用校验节点结构、展示变更预览，并以当前 revision 保存，流式过程中的不完整内容不会写入项目。

## 导出中心

导出中心是可恢复的四阶段本地流程，将已确认节点整理为最终交付物。所有产物持久化在项目 `exports/` 目录，无云同步与导出历史。

| 阶段 | 产物 | 说明 |
|---|---|---|
| 1. 导出蓝图 | 结构化蓝图 | 由前 11 个内容节点生成，须批准后才能生成正文 |
| 2. 正式正文 | 可交付 PRD 正文 | 通过结构校验（唯一一级标题、二级标题下有正文、无 TBD/TODO 占位），须批准后生成 Word |
| 3. 正式 Word 与 QA | DOCX + QA 报告 | 由已批准正文确定性生成，保留标题层级、封面、目录、列表与表格；QA 失败则保留上一次通过的 Word |
| 4. 工程附件 | `PROJECT_DESIGN.md` / `SPEC.md` / `TASKS.md` / `AGENTS.md` | QA 通过后确定性生成，四份全部写入才标记完成 |

行为规则：

- 重新生成已有蓝图或正文时，先生成候选并展示差异，确认后以修订号与摘要校验替换，不直接覆盖。
- 手动编辑或应用评审补丁会撤销对应文件的批准；下游文件保留并标记为基于旧版本。来源节点变化仅产生提示，不撤销批准。
- 评审意见以任务形式执行，结果为结构化补丁，须逐项预览差异后应用。
- 模型只在生成蓝图、正文和评审建议时调用；批准、Word 生成、QA、工程附件与另存为均不需要模型。

## 本地数据与隐私

全局配置位于 `~/.sion/`，项目数据位于所选项目目录下，按项目 ID 分文件夹存放：

```text
~/.sion/
├── settings.json
├── providers.json      # 提供商配置与 API Key（明文，文件权限受限）
└── registry.json

<项目目录>/
└── <项目 ID>/
    ├── project.json
    ├── nodes/          # 节点工作稿（CAS 版本化保存）
    ├── chat/           # 会话记录
    ├── files/          # 导入附件与提取文本
    ├── agent-overrides/
    ├── exports/        # 导出产物
    └── runs/           # Agent 运行记录
```

隐私约束：

- API Key 仅保存在 `~/.sion/providers.json`，不进入项目数据、导出物、日志或 IPC 摘要。
- `~/.sion/` 与项目目录可能包含客户资料，不应提交到公共仓库。
- 模型只接收当前项目内允许的节点、蓝图或正文内容。

## 构建与发布

```bash
npm run build:desktop        # 当前平台：构建但不打包
npm run bundle:mac           # macOS：本机架构 App 与 DMG
npm run bundle:mac-universal # macOS：Apple Silicon + Intel Universal App/DMG
npm run bundle:windows       # Windows：NSIS 与 MSI 安装器
```

推送 `v*` tag（如 `v1.0.0`）触发 GitHub Actions：macOS 构建 Universal DMG、Windows x64 构建 NSIS 安装器并上传至 GitHub Releases。当前流水线产出未签名开发验证包；正式发布需平台代码签名，macOS 直链分发还需 Apple 公证。详见 [RELEASE.md](RELEASE.md)。
