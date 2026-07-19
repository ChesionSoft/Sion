# 导出中心重设计

日期：2026-07-19

## 摘要

参考旧 Next.js 版本的完整导出工作流，在当前本地优先 Tauri 桌面架构中重新建设导出中心。新设计恢复“导出蓝图 → 正式正文 → Word 与 QA → 工程附件与发布”流程，但不复制旧代码，也不把导出逻辑移回 React。

核心产品调整如下：

- 导出蓝图是准备材料，不是交付产物。它单独显示在页面顶部的准备区。
- 其余 7 项文件进入交付产物区：正式正文、QA 报告、正式 Word，以及 `PROJECT_DESIGN.md`、`SPEC.md`、`TASKS.md`、`AGENTS.md`。
- 主体采用产物导航、文档预览和评审任务账本三栏工作台。
- 评审修改不是工作台聊天。每条意见都是绑定具体文档修订的评审任务，结果必须经过结构化差异预览和用户确认才能应用。
- Markdown 直接预览；DOCX 转为经过清理的 HTML 做内容预览，并明确说明实际分页、目录、页眉页脚需在 Word 或 WPS 中查看。
- 8 个文件均持久化在项目 `exports/` 内；正式 Word 可通过原生“另存为”复制到用户选择的位置。
- Rust 拥有导出状态、项目文件、模型运行、修改验证、DOCX、QA 和预览。React 只负责呈现和操作编排。

## 背景

当前桌面版导出中心只允许选择项目并一次性另存 DOCX。它没有旧 Next.js 版本已经验证过的蓝图、正式正文、人工批准、评审修改、产物列表、内容预览和 DOCX QA 流程。

旧版本的不足也不能原样带回：

1. 蓝图与中心产物混排，模糊了“准备材料”和“交付文件”的边界。
2. Agent 修改使用接近聊天输入框的形式，与工作台对话缺少产品差异。
3. 旧实现依赖 Next.js API、Node 文件访问和浏览器式下载，不符合当前 Tauri 架构。
4. 生成、审批、文件、QA 和 UI 状态需要在 Rust 中形成可恢复、可测试的明确边界。

## 目标

1. 恢复完整的蓝图、正式正文、Word/QA 和工程附件流程。
2. 保留 Markdown 与 DOCX 内容预览。
3. 将蓝图与正式交付产物明确分区。
4. 提供区别于聊天的结构化评审任务账本。
5. 所有模型写入都经过结构验证；修改现有内容时必须先预览差异，再由用户确认。
6. 支持模型选择和推理强度，并按项目记住上次选择。
7. 支持项目切换、运行取消、应用重启后的磁盘恢复和并发冲突保护。
8. 保持项目内写入原子化，不泄露 API Key、原始 Provider 帧或内部敏感错误。

## 非目标

- PDF、HTML 包或其他新导出格式。
- 云端导出、云同步、共享链接、计划任务或后台定时导出。
- 交付产物版本库或导出历史时间线。
- 把评审任务扩展成多会话聊天、连续追问、附件对话或通用 Agent 中心。
- 在应用内实现分页级、像素级的 Word 仿真渲染。
- 浏览器搜索、浏览器自动化、Playwright 或新的 Web 出口。
- 迁移或复用旧 Next.js 运行时。
- 重构与导出中心无关的工作台功能。

## 已选方案

采用 Rust 原生分层方案：

- `sion-core` 定义导出领域类型、状态转换、摘要批准、蓝图/正文校验和结构化修改补丁。
- `sion-storage` 原子保存导出状态、产物元数据、评审任务和 CAS 修订。
- `sion-agent` 执行蓝图、正文和评审建议生成，复用现有 Provider SSE、取消和安全错误规则。
- `src-tauri` 负责版本化命令、运行编排、每项目互斥、事件、受限预览和原生另存为。
- React 负责页面布局、快照渲染、差异选择和用户操作，不直接访问文件或模型网络。

不采用 React 持有业务状态的方案，因为它会把可恢复流程拆散到内存和磁盘。也不采用单体 `src-tauri` 导出模块，因为模型、存储、状态机和 DOCX 会重新耦合。

## 入口与项目选择

导出中心继续作为主侧边栏的全局目的地。

- 从项目工作台进入时，默认选中当前项目。
- 从全局导航进入时，优先选中本次应用会话最近使用的导出项目；没有记录时选择最近打开的项目。
- 页面头部提供项目切换器，可随时切换到其他项目。
- 项目切换不取消后台运行。每个项目独立展示自己的运行和产物状态。
- 没有项目时显示创建或发现本地项目的空状态。

模型选择以全局默认 Provider、模型和推理强度初始化，并写入该项目的导出状态。项目再次打开时恢复上次选择。只保存 Provider ID、模型名和推理强度，不保存 API Key。

## 页面结构

### 顶部区域

页面顶部依次包含：

1. 项目切换器和“导出中心”标题。
2. 流程进度：导出蓝图、正式正文、Word 与 QA、完成。
3. 当前项目警告，例如节点未完成、来源节点已变化或下游产物基于旧版本。
4. 独立的 `BlueprintPreparationBar`。

`BlueprintPreparationBar` 必须使用“准备材料”标识，展示蓝图是否存在、是否批准、是否过期，并提供查看、编辑、评审和批准入口。它不出现在交付产物列表中。

### 三栏工作台

主体采用三栏：

- `ArtifactNavigator`：只列 7 项交付产物。
- `ArtifactPreview`：显示当前蓝图或产物的预览、源码编辑或差异预览。
- `ReviewLedger`：蓝图和正式正文显示评审任务；其他只读产物显示元数据、来源摘要、QA 状态和可用操作。

交付产物分组如下：

**正式交付**

1. `formal-prd-draft.md`，显示名“正式正文”。
2. `formal-prd-qa-report.md`，显示名“Word QA 报告”。
3. `项目开发设计文档.docx`，显示名“正式 Word”。

**工程附件**

4. `PROJECT_DESIGN.md`。
5. `SPEC.md`。
6. `TASKS.md`。
7. `AGENTS.md`。

工程附件默认折叠，但文件存在、缺失、过期和选中状态必须可见。不存在的文件以禁用占位显示，帮助用户理解完整输出集合。

### 底部操作栏

`ExportActionBar` 固定在工作区底部，包含：

- 项目级模型选择器。
- 推理强度选择器。
- 当前阶段唯一主操作。
- 运行进度和取消操作。

生成蓝图、生成正文和生成评审建议需要模型。批准、DOCX 生成、QA、工程附件生成和原生另存为不需要模型；执行这些操作时模型选择器仍可见但不作为启用条件。

## 工作流

### 第一步：导出蓝图

系统读取前 11 个内容节点，不把 `final-export` 节点作为蓝图输入。启动前展示节点状态和缺失内容警告。

节点未全部完成不会阻止生成。用户确认警告后可继续。

第一次生成蓝图时：

1. 创建项目级导出运行记录。
2. 使用当前项目模型偏好调用 Provider。
3. 要求模型返回一个完整、闭合的 fenced `delivery` JSON 块。
4. 解析并验证导出蓝图结构。
5. 仅在模型输出完整且验证通过后原子写入 `export-blueprint.md`。

重新生成已有蓝图时，不直接覆盖。系统生成一个完整候选，展示与当前蓝图的差异，用户确认后才以 CAS 替换。验证通过的候选持久化到项目 `exports/candidates/`，因此应用重启后仍可继续审阅；候选不是交付产物，也不出现在产物列表中。

用户可预览或手动编辑蓝图。手动保存使用预期修订号和预期摘要，保存前执行同一蓝图校验。

批准操作记录当前蓝图摘要。只有当前摘要已批准时才能生成正式正文。

### 第二步：正式正文

正式正文使用当前已批准蓝图和前 11 个节点作为输入。生成规则与蓝图一致：首次生成在完整验证后写入；重新生成先形成持久化候选并展示差异，再由用户确认替换。

正式正文必须通过以下校验：

- 只有一个一级标题。
- 至少包含一个二级标题。
- 不包含“待生成”“TODO”“TBD”等占位内容。
- 标题结构可映射到 Word 目录。
- 内容不是空白、截断响应或 fenced `delivery` 块之外的说明文字。

用户可预览、手动编辑、创建评审任务并批准当前正文摘要。只有当前摘要已批准时才能生成正式 Word。

### 第三步：正式 Word 与 QA

正式 Word 由已批准正文确定性生成，不调用模型。

生成过程：

1. 在 `exports/` 内创建唯一临时候选文件。
2. 渲染封面、项目元数据、目录、修订记录、标题层级、列表、表格、代码块、页眉页脚和分页正文。
3. 对候选执行结构与内容 QA。
4. QA 通过后，原子替换当前正式 Word，并写入通过报告。
5. QA 失败时删除候选，写入失败报告，不发布候选。

若项目已有上一次通过 QA 的 Word，新候选失败不会删除旧 Word。旧 Word 保留并标记为“基于旧正文”；最新 QA 报告明确指出它检查的是失败候选，避免把旧 Word 误报为已通过当前正文 QA。

### 第四步：工程附件与完成

`finalize_docx` 在正式 Word QA 通过后继续生成或更新：

- `PROJECT_DESIGN.md`
- `SPEC.md`
- `TASKS.md`
- `AGENTS.md`

这些文件由项目清单和当前节点确定性生成，不调用模型。每个文件单独原子替换；只有四个文件均写入成功，批次状态才进入“完成”。单文件写入失败时，已通过 QA 的 Word 保持可用，状态记录失败项，已成功的同批新文件不作为完整批次对外声明；页面主操作变为重试完整附件批次。`generate_engineering_attachments` 既用于该重试，也用于 Word 已通过后单独重建工程附件。这里不承诺跨四个文件的文件系统事务。

正式 Word 可通过原生保存面板另存为外部副本。取消保存面板是正常取消，不生成错误通知。外部副本路径不写入项目状态，也不作为导出历史。

## 预览与编辑

### Markdown

蓝图、正文、QA 报告和工程附件复用安全 Markdown 渲染策略。预览必须禁用原始 HTML、脚本、远程资源和不受支持的链接协议。

只有蓝图和正式正文可编辑。QA 报告和工程附件是生成结果，只读。

### DOCX

Rust 从固定白名单中的正式 DOCX 读取有界内容并转换为经过清理的 HTML。预览覆盖正文标题、段落、列表和表格，但不承诺封面、可点击目录、分页、页码、页眉或页脚保真。

DOCX 预览顶部固定显示：

> 当前为内容预览。封面、目录、页眉页脚和分页请另存后在 Word 或 WPS 中查看。

前端不得把未经清理的 DOCX HTML直接传给 `dangerouslySetInnerHTML`。

## 评审任务账本

评审任务只适用于 `export-blueprint.md` 和 `formal-prd-draft.md`。

每项任务包含：

- 任务 ID。
- 目标文件类型。
- 用户的一条聚焦评审意见。
- 创建时的目标修订号和内容摘要。
- Provider ID、模型和推理强度。
- 状态：`queued`、`running`、`ready`、`partially_applied`、`applied`、`stale`、`failed` 或 `cancelled`。
- 结构化修改建议。
- 每项建议的应用或跳过结果。
- 创建、完成和应用时间。

评审任务没有会话 ID、消息列表、聊天气泡、连续追问或附件。用户若要继续修改，应创建新的评审任务。

Agent 必须返回 fenced `delivery` JSON，其中只包含受支持的结构化修改操作：

- 蓝图：按蓝图 section ID 更新、插入、删除或重排。
- 正文：按唯一二级标题替换、插入、删除或重排章节。

不允许模型直接写文件或返回整份不受约束的替换正文作为评审结果。

任务进入 `ready` 后，界面展示逐项差异。用户可选择部分或全部建议并点击“应用修改”。应用时重新检查目标修订号、内容摘要和补丁合法性，然后以 CAS 写入。

如果文档已变化，任务标记为 `stale`，拒绝应用旧建议。用户可保留任务记录并基于最新文档重新发起新的任务。

应用评审建议与手动编辑具有相同批准语义：目标文件摘要变化后撤销该文件批准。

## 过期与批准语义

系统区分两种变化。

### 来源节点变化

蓝图、正文和工程附件在生成时保存前 11 个节点的修订号与内容摘要快照。当前节点与快照不同则显示“来源节点已变化”。

该提示是 advisory：

- 不自动撤销蓝图或正文批准。
- 不删除任何产物。
- 不阻止继续生成、预览、另存或下载。
- 用户可以明确选择按当前已批准内容继续。

### 蓝图或正文变化

手动编辑、应用评审补丁或确认重新生成候选后，目标文件摘要发生变化：

- 立即撤销该文件的批准摘要。
- 下游文件保留并标记为基于旧版本。
- 继续生成下一阶段前，必须批准当前文件摘要。

这条规则不是来源节点过期提示，不能被绕过。它确保“批准”始终指向用户实际审阅过的文件内容。

## 领域模型

领域语义固定如下；Rust 使用 `snake_case`，IPC 使用 `camelCase`。

```text
ExportArtifactKind
  blueprint
  formal_draft
  qa_report
  formal_docx
  project_design
  spec
  tasks
  agents

ExportArtifactRecord
  kind
  filename
  revision
  digest
  byte_size
  updated_at
  source_snapshot?
  based_on_blueprint_digest?
  based_on_draft_digest?

ExportSourceSnapshot
  node_id -> { revision, digest }

ExportApproval
  artifact_kind
  approved_revision
  approved_digest
  approved_at

ExportQaState
  none
  passed { report, checked_draft_digest, checked_at }
  failed { report, checked_draft_digest, checked_at }

ExportCandidate
  id
  target_kind: blueprint | formal_draft
  base_revision
  base_digest
  candidate_digest
  markdown
  model_selection
  created_at

ExportWorkspaceState
  schema_version
  model_selection
  artifacts
  blueprint_approval?
  draft_approval?
  qa_state
  pending_candidates
  active_run_id?
  updated_at

ExportReviewTask
  id
  target_kind
  instruction
  base_revision
  base_digest
  model_selection
  status
  proposed_changes[]
  applied_results[]
  created_at
  finished_at?
  applied_at?
```

摘要使用稳定的 SHA-256 十六进制字符串。修订号只在成功替换对应文件后递增。批准以修订号和摘要双重绑定。

每个目标文件最多保留一个待处理重新生成候选。新候选替换同目标的旧候选。候选应用时再次检查 `base_revision` 与 `base_digest`；冲突时保留候选并拒绝覆盖。应用或明确丢弃后删除候选文件。候选不构成交付历史，也不长期保留已应用版本。

## 项目内持久化

固定布局：

```text
<projects directory>/<project id>/
  exports/
    export-state.json
    export-blueprint.md
    formal-prd-draft.md
    formal-prd-qa-report.md
    项目开发设计文档.docx
    PROJECT_DESIGN.md
    SPEC.md
    TASKS.md
    AGENTS.md
    candidates/
      <candidate-id>.json
    reviews/
      <review-task-id>.json
```

所有路径从已注册项目根目录和固定枚举推导。IPC 不接受任意文件名或路径。

JSON、Markdown 和 DOCX 均采用同目录临时文件、`sync_all`、原子重命名和目录同步。失败时清理临时文件。导出状态必须在产物成功写入后更新，不能声明不存在的文件已完成。启动读取时以磁盘文件摘要校验状态记录；文件与状态不一致时报告明确恢复错误，不自动删除或覆盖用户文件。

候选 JSON 只保存完整且通过领域校验的 Markdown，不保存部分模型输出或原始 Provider 响应。磁盘发现后，只有 `export-state.json` 引用的当前候选可进入界面；孤立候选作为可清理恢复错误报告，不自动应用。

评审任务使用独立文件，磁盘发现后按创建时间倒序展示，不维护容易与任务文件失配的可变索引。

正在运行的导出任务复用项目 `runs/` 诊断记录。只保存状态、公开阶段摘要、模型元数据、时间和安全错误；不保存完整提示词、API Key、Provider 请求头、原始 SSE 帧或隐藏推理。

## 运行与并发

每个项目同一时间只允许一个改变导出状态的运行：蓝图生成、正文生成、评审建议、Word/QA 或工程附件生成。

- 预览和读取不获取写锁。
- 不同项目可以独立运行，但仍受现有 Agent 全局并发限制。
- 项目切换不取消运行。
- 运行可显式取消。
- Provider 取消或失败不得保存部分模型输出。
- 应用关闭时未完成运行在下次恢复为 `interrupted`，不会显示为成功，也不会自动重跑。

React 以 `projectId` 和 `runId` 过滤事件。来自其他项目、旧运行或已取消运行的事件不能改变当前页面状态。

## Tauri 命令与事件

命令沿用版本化请求信封。语义合同如下：

- `export_workspace_get(projectId)`：返回项目导出状态、产物元数据、来源过期提示、评审任务摘要和活动运行。
- `export_model_selection_save(projectId, modelSelection)`：验证并保存该项目的 Provider、模型和推理强度偏好。
- `export_artifact_get(projectId, artifactKind, view)`：返回有界 Markdown、源码或经过清理的 DOCX HTML 内容预览。
- `export_artifact_save(projectId, artifactKind, expectedRevision, expectedDigest, markdown)`：CAS 保存蓝图或正文。
- `export_artifact_approve(projectId, artifactKind, expectedRevision, expectedDigest)`：批准当前蓝图或正文。
- `export_action_start(projectId, action, modelSelection?, expectedRevision?, expectedDigest?)`：启动 `generate_blueprint`、`regenerate_blueprint`、`generate_draft`、`regenerate_draft`、`finalize_docx` 或 `generate_engineering_attachments`。
- `export_action_cancel(projectId, runId)`：取消活动运行。
- `export_candidate_apply(projectId, candidateId, expectedRevision, expectedDigest)`：验证并 CAS 应用重新生成候选。
- `export_candidate_discard(projectId, candidateId)`：明确丢弃待处理候选。
- `export_review_start(projectId, artifactKind, instruction, expectedRevision, expectedDigest, modelSelection)`：创建并运行评审任务。
- `export_review_apply(projectId, taskId, selectedChangeIds, expectedRevision, expectedDigest)`：验证并 CAS 应用选中建议。
- `export_docx_save_as(projectId)`：通过原生保存面板复制当前正式 Word。

错误使用稳定的领域分类，而不是要求 React 解析消息文本：

- `not_found`
- `validation_failed`
- `revision_conflict`
- `stale_review`
- `run_busy`
- `provider_failed`
- `qa_failed`
- `cancelled`
- `io_failed`

运行事件：

```text
export-run-updated
export-review-updated
export-workspace-invalidated
```

每个事件携带 `projectId`、`runId`、安全公开状态和时间。终态必须先持久化，再发出完成事件。`export-workspace-invalidated` 只要求前端重新读取快照，不携带整份项目文档。

## 错误处理

- Provider 失败：保留现有文件；记录安全错误；不保存部分候选。
- 用户取消：保留现有文件；记录取消状态；不显示为失败。
- 修订冲突：返回最新修订号和摘要；不自动覆盖或自动重放补丁。
- 评审建议过期：标记任务过期并拒绝应用。
- QA 失败：删除本次候选 Word，保存失败报告；保留上一次通过的 Word并标记旧版本。
- 原生另存为取消：返回 `exported: false`，不生成错误通知。
- 磁盘状态损坏：页面显示项目级错误和具体受影响文件，不自动重置或删除用户数据。
- 工程附件批次失败：不进入“完成”，保留明确失败项并允许重试整个批次。

## 安全与隐私

- API Key 只从 `~/.sion/providers.json` 读取，继续使用受限权限。
- API Key 不进入项目数据、导出物、日志、运行记录、事件或 IPC 摘要。
- 预览仅允许固定 `ExportArtifactKind`，拒绝 `..`、绝对路径、分隔符和任意文件名。
- Markdown 禁止原始 HTML、脚本、远程图片和危险协议。
- DOCX HTML 在 Rust 端转换并清理，前端再次使用固定允许标签策略。
- 读取预览设置字节和字符上限；超限时返回截断标记和下载提示。
- 模型只接收当前项目内明确允许的节点、蓝图或正文，不读取其他项目或全局文件。
- 不增加浏览器、搜索、自动化或其他 Web egress。

## 组件边界

- `crates/sion-core`：新增聚焦的导出领域模块；不依赖 Tauri、文件系统或 Provider。
- `crates/sion-storage`：新增导出存储模块，负责固定路径、原子文件、CAS、任务发现和恢复。
- `crates/sion-agent`：新增导出运行类别和生成入口，复用现有模型流与取消设施。
- `src-tauri/src/export_runtime.rs`：编排命令、项目锁、事件和错误映射。
- `src-tauri/src/project_export.rs`：继续负责确定性 DOCX 生成。
- `src-tauri/src/docx_check.rs`：扩展为实际导出 QA，而不只做启动自检。
- `src-tauri/src/docx_preview.rs`：提供有界、安全的 DOCX 内容 HTML 转换。
- `src/api.ts` 与 `src/types.ts`：版本化 IPC 包装与共享前端类型。
- `src/components/app/ExportCenter.tsx`：页面容器和快照加载，不堆积所有子功能。
- `src/components/export/`：放置蓝图区、产物导航、预览、评审账本、差异预览和操作栏等聚焦组件。
- `src/App.tsx`：只持有目的地选择、项目级导出运行映射和全局通知，不持有导出状态机。

`ExportCenter.tsx` 不应重新成长为包含网络、状态机、预览、编辑和评审全部逻辑的单文件组件。

## 测试策略

### `sion-core`

- 蓝图和正文合法、非法及占位内容校验。
- 摘要批准只绑定当前修订。
- 来源节点变化只产生 advisory，不撤销批准。
- 蓝图或正文变化撤销对应批准并标记下游旧版本。
- 蓝图与正文补丁的更新、插入、删除、重排和非法目标。
- 部分选择建议仍产生合法最终文档。

### `sion-storage`

- 8 个固定文件和导出状态往返。
- 原子文件替换和临时文件清理。
- 重新生成候选持久化、单目标替换、重启恢复、CAS 应用与丢弃。
- CAS 冲突保留最新用户数据。
- 评审任务磁盘发现与排序。
- 损坏状态返回明确错误而不是重置。
- 所有写入保持在直接 UUID 项目目录内。

### `sion-agent`

- 蓝图、正文和评审建议解析 fenced `delivery` JSON。
- 截断、缺少 fence、非法 JSON 和不支持补丁拒绝保存。
- Provider 失败、取消和超时不留下部分产物。
- 已完整验证的重新生成结果成为候选，不直接覆盖当前蓝图或正文。
- 公开运行摘要不包含隐藏推理或机密。

### Tauri

- 所有命令校验 API 版本和项目注册。
- 项目级互斥及不同项目并行行为。
- 固定产物枚举与路径穿越拒绝。
- Markdown、DOCX HTML 预览限制与清理。
- QA 失败删除候选并保留旧通过 Word。
- 候选应用和丢弃命令只接受当前状态引用的候选 ID。
- 原生另存为成功、扩展名补齐和用户取消。
- 终态先持久化后发事件。

### React

- 当前或最近项目默认选择和项目切换。
- 蓝图只出现在独立准备区，不进入 7 项产物列表。
- 工程附件折叠分组和缺失占位。
- Markdown、源码、DOCX 内容预览和保真提示。
- 评审任务账本不渲染聊天气泡或会话控件。
- 差异逐项选择、应用、过期和冲突状态。
- 重新生成候选在重启后恢复差异预览，并可应用或丢弃。
- 模型偏好恢复、运行取消和跨项目事件过滤。
- 来源节点变化显示警告但不禁用生成或另存。

## 人工验收

1. 从尚未完成的项目进入导出中心，看到缺失节点警告但可继续生成。
2. 生成、预览、编辑、评审并批准蓝图。
3. 确认蓝图不出现在交付产物列表。
4. 生成、预览、评审并批准正式正文。
5. 创建评审任务，选择部分建议，检查差异后应用。
6. 修改源节点，确认只出现过期提示，已有批准和下载仍可用。
7. 修改蓝图或正文，确认对应批准撤销且下游文件保留并标记旧版本。
8. 生成 Word；QA 通过后预览内容，并在 Word/WPS 中检查封面、目录、页眉页脚和分页。
9. 构造 QA 失败，确认候选被删除、报告可预览、旧通过 Word未丢失。
10. 预览并核对 4 个工程附件。
11. 使用原生另存为发布正式 Word，验证中文路径与扩展名处理。
12. 在运行中切换项目并重启应用，确认状态、模型偏好、产物和评审任务从磁盘正确恢复。
13. 在 macOS Apple Silicon、macOS Intel 和 Windows x64 上验证保存面板与 DOCX 打开效果；缺少真机时对应平台只能标记为未完成验收。

## 成功标准

- 导出中心提供完整、可恢复的四阶段流程。
- 蓝图在视觉、语义和导航上均与 7 项交付产物分离。
- 评审修改明显区别于聊天，并且任何 Agent 修改都不能绕过差异预览、验证和用户确认。
- 所有产物都可在应用内进行适合其格式的内容预览。
- 来源过期、批准失效、QA 失败、取消和冲突都有明确且互不混淆的状态。
- 项目文件、API Key 和模型运行继续满足仓库的本地优先、安全和原子写入约束。
- 现有工作台聊天、节点交付、文件池和 Provider 设置行为不回归。
