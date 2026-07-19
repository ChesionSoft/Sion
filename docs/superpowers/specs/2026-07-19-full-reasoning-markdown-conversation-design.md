# 完整公开思考与会话 Markdown 可视化设计

**日期：** 2026-07-19
**状态：** 已批准，待实施计划

## 目标

修复当前会话展示中的两个关联问题：

1. 模型提供的公开思考摘要被前端和 Rust 各自截断为 2,000 个 Unicode 字符，用户无法查看完整内容；思考内容又以纯文本展示，Markdown 结构不可读。
2. Agent 可见正文是 Markdown，但 `ConversationTurnCard` 直接输出字符串，标题、列表、表格、引用和代码块均未可视化。

完成后，Sion 应完整接收并保存模型明确提供的公开思考摘要，正文和思考均在流式阶段实时渲染安全 GFM Markdown；长思考通过默认折叠、有界高度和内部滚动保持会话紧凑。

## 现状与根因

当前数据链路已经区分 `OutputText` 与 `ReasoningSummary`，也会在 Rust 中把可见正文与尾部的 fenced `delivery` JSON 隔离。这些安全边界无需重做。

无法完整显示思考的直接原因有两处：

- `src/reasoning-stream.ts` 在拼接瞬时公开思考时将结果限制为 2,000 个字符。
- `src-tauri/src/turn_runtime.rs` 的 `public_reasoning_summary` 在持久化前再次限制为 2,000 个字符。

格式异常来自展示层：

- `ConversationReasoningDisclosure` 使用普通 `div` 和 `white-space: pre-wrap` 输出思考。
- `ConversationTurnCard` 直接输出 `assistantMessage.content`。
- 现有 `MarkdownPreview` 已使用 `react-markdown` 与 `remark-gfm`，但组件同时包含交付稿专属布局，尚不能直接作为聊天正文和思考区的共享渲染核心。

旧 Next 版本提供了可借鉴的方向：Agent 正文使用共享的安全 GFM 渲染器，长思考内容保留在可滚动区域内。但本设计沿用当前 Tauri 应用更严格的 URL 与图片策略，不恢复旧版的外部链接行为。

## 已选方案

提取一个共享的安全 Markdown 渲染核心，并为交付稿、聊天正文和公开思考提供样式变体。

未选择的方案：

- 直接把现有 `MarkdownPreview` 嵌入会话会产生文档 padding、纵向 overflow 与思考面板内部滚动之间的耦合。
- 分别为正文和思考创建独立 Markdown 组件会重复 GFM 配置、安全策略和错误处理，后续容易漂移。

## 组件设计

### `SafeMarkdown`

共享组件只负责把传入字符串安全地渲染为 GFM Markdown。它提供 `document`、`chat`、`reasoning` 三种视觉变体，但三者共享完全相同的解析与安全规则。

支持范围：

- 标题、段落、强调、列表、任务列表、表格、引用、分隔线、行内代码和 fenced code block。
- 原始 HTML 不启用 `rehype-raw`，因此只作为文本处理，不能生成可执行 DOM。
- 所有链接只显示为带语义样式的文字，不创建可导航链接。
- 所有图片显示可读占位符，例如 `[图片：架构图]`，不访问远程、本地或相对 URL。
- 表格和代码块在自己的容器内横向滚动，不得撑破会话列。

组件外包裹 Markdown 错误边界。若解析或自定义渲染器抛错，回退为保留换行的原始纯文本；任何情况下都不得让整条消息或思考内容消失。

### 使用方

- `MarkdownPreview` 保留为交付稿语义组件，内部改用 `SafeMarkdown` 的 `document` 变体，并继续负责交付稿区域的 padding 与纵向滚动。
- `ConversationTurnCard` 的 Agent 正文使用 `chat` 变体。用户消息继续按纯文本显示，避免把用户输入误解释为 Markdown。
- `ConversationReasoningDisclosure` 的内容区使用 `reasoning` 变体。折叠、字数、活动状态与纵向滚动仍由 disclosure 组件负责，不进入 Markdown 核心。

## 数据流与持久化

### 运行中

1. Provider 帧只在已支持的公开字段中产生 `ReasoningSummary`；隐藏 `reasoning_content` 继续被忽略。
2. Tauri 继续分别发出正文 token 与公开思考 delta，并继续通过 `DeliveryStreamProjector` 隔离 fenced `delivery` JSON。
3. React 按 project、node、session 和 run 作用域拼接瞬时公开思考，但不再限制为 2,000 字符。
4. 活动轮次把当前完整字符串传给 `SafeMarkdown`。每个增量到达时，未闭合的 Markdown 按现有片段尽力渲染；后续 token 会自然修正结构。

### 成功完成

Rust 将所有非空公开思考片段拼接为现有 `ConversationTurn.reasoningSummary`，不再施加应用层字符截断。前端移除对应 run 的瞬时值，并以持久化轮次作为唯一终态来源。

不新增项目字段，不修改 schema 版本，也不需要迁移。历史轮次继续使用现有可选字段；历史正文和思考会自动获得新的 Markdown 展示。

### 失败与取消

本次设计不扩大失败与取消的持久化语义。运行期间已收到的公开思考可以实时显示，但失败或取消后的未完成思考不写入历史记录，避免将残缺推理标记为完整摘要。

若 Provider 从未提供公开思考，运行中展开面板显示“模型暂未提供公开思考内容”；终态不存在 `reasoningSummary` 时不渲染空面板。

## 思考区交互

- disclosure 默认折叠。
- 活动轮次标签为“Agent 正在思考”，完成轮次标签为“思考内容”。
- 展开状态由当前组件管理，并在该轮次组件存活期间保持；不写入项目数据或全局设置。
- 标题显示已接收的 Unicode 字符数，帮助用户确认内容仍在增长。
- 展开内容的最大高度为 `min(360px, 45vh)`，超出后使用内部纵向滚动；数据本身不截断。
- 实时 delta 到达时不主动改变 `scrollTop`，避免用户阅读上文时被强制拉到底部。
- button 保留原生键盘交互和 `aria-expanded`；活动状态继续使用现有可访问标签与视觉指示。

## 正文展示

- Agent 正文从首个可见 token 起就使用 `SafeMarkdown` 的 `chat` 变体，不在完成时切换组件或展示模式。
- 正文自然撑高会话轮次，不增加正文内部纵向滚动。
- 未闭合列表、表格或代码块在流式阶段允许短暂重排，这是实时 Markdown 的预期行为。
- Provider 模型与执行信息继续显示在正文之后，不进入 Markdown 内容树。

## 安全边界

以下内容不得因为 Markdown 可视化而进入 UI：

- Provider 隐藏思维链或 `reasoning_content`。
- 原始 Provider SSE 帧、请求信息、内部提示词或错误响应体。
- fenced `delivery` JSON 及其不完整前缀。

Markdown 不执行 HTML，不导航 URL，不加载图片或其他资源。安全规则集中在 `SafeMarkdown`，而不是依赖三个使用方分别配置。

## 性能与容量

取消 2,000 字限制会增加长轮次在内存和项目记录中的体积，这是“完整显示公开思考”的明确取舍。视觉高度通过内部滚动控制，而不是通过删除数据控制。

本次不引入虚拟化、增量 AST 或新的持久化文件。Provider 公开思考通常远小于正文上下文；若未来实际数据证明完整字符串反复解析成为性能瓶颈，应另行设计基于节流或分段渲染的优化，而不在本次提前增加复杂度。

## 错误处理

- Markdown 解析或渲染异常：显示原始纯文本并保留换行。
- 流式 Markdown 暂不完整：按当前字符串渲染，不报错、不清空内容，等待后续 delta 修正。
- 空公开思考：活动时显示明确占位文案，终态不显示空 disclosure。
- 超宽 Markdown：仅表格和代码块局部横向滚动，外层会话不横向溢出。
- 旧项目缺少 `reasoningSummary`：按无思考历史轮次处理，不触发迁移或错误。

## 测试设计

### Rust

- `public_reasoning_summary` 保留超过 2,000 个 Unicode 字符的完整公开摘要。
- 空白片段仍被过滤，片段顺序与内容保持正确。
- 支持的公开字段继续产生 `ReasoningSummary`。
- 隐藏 `reasoning_content` 不产生公开 delta。
- `DeliveryStreamProjector` 在 fence 跨 token 时仍不泄露 `delivery` JSON。

### 前端状态

- `appendLiveReasoning` 完整拼接超过 2,000 字符的作用域匹配增量。
- project、node、session 或 run 不匹配时不串流。
- 成功终态移除瞬时内容并使用持久化轮次。
- 导航、失败与取消沿用现有清理边界。

### Markdown 与组件

- 正文和思考均渲染 GFM 标题、列表、表格、引用和代码。
- 原始 HTML 不成为真实元素。
- 链接不可导航，图片只显示占位符。
- 表格和代码块具备局部横向滚动容器。
- 渲染器抛错时显示原始纯文本。
- 思考区默认折叠、暴露正确的 `aria-expanded`，展开后应用有界高度与纵向滚动。
- 没有公开思考的历史轮次不显示空 disclosure。
- 交付稿预览继续使用相同安全策略，现有布局不回退。

### 完整验证

- `npm run lint`
- `npm run build`
- `npm run test:ui`
- `npm run test:rust`
- `npm run test:storage-contract`
- `npm run test:no-browser-runtime`
- `npm run test:no-legacy-migration-runtime`
- `cargo test --workspace`
- `cargo clippy --workspace -- -D warnings`

## 验收标准

1. 超过 2,000 个 Unicode 字符的 Provider 公开思考在运行中和成功历史轮次中均可完整查看。
2. Agent 正文和公开思考从流式阶段起实时呈现安全 GFM Markdown。
3. 长思考不会无限撑高会话；默认折叠，展开后可在有界面板中滚动到最后一个字符。
4. 表格、代码、链接、图片与 HTML 均遵守既定安全和溢出规则。
5. Markdown 渲染失败不会隐藏内容。
6. 隐藏思维链与 `delivery` JSON 不会进入可见正文或思考区。
7. 交付稿预览和历史项目保持兼容，无数据迁移。

## 非目标

- 展示隐藏 chain-of-thought 或 Provider 的原始 `reasoning_content`。
- 持久化失败或取消轮次的未完成公开思考。
- 允许聊天 Markdown 打开链接、加载远程图片或读取本地文件。
- 语法高亮、Mermaid、数学公式、原始 HTML 或自定义插件系统。
- 为超长 Markdown 引入虚拟化、worker 或增量 AST。
