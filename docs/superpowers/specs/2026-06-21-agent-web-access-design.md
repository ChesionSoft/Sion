# Agent 联网与 URL 读取设计

日期：2026-06-21
状态：设计已确认，待用户复核后进入 writing-plans

## 1. 背景与目标

Sion 当前只把消息发送到 OpenAI-compatible Chat Completions endpoint。模型可以使用项目节点、聊天消息和用户上传文件，但没有搜索工具，也不会读取消息中的网页地址。

联网不是 Sion 的主要信息来源。本次设计只增加两项辅助能力：

1. 用户消息包含公开 URL 时，服务端自动读取页面正文并作为本轮参考材料。
2. 用户主动开启联网开关时，支持 OpenAI Responses API 原生 Web Search 的模型可以搜索互联网。

设计必须满足：

- 未开启联网时绝不发起全网搜索。
- URL 读取不依赖联网开关，也不要求客户配置搜索服务。
- 不支持原生搜索的模型仍能正常聊天，不能因为联网不可用而中断请求。
- 外部内容必须保留来源，不能直接成为交付稿中的已确认事实。
- 所有外部请求在服务端执行，并防止 SSRF、超大响应和网页提示注入。

## 2. 已确认的产品决策

- 不做联网意图识别。是否搜索完全由用户控制。
- 输入栏提供联网开关；开启后保持开启，直到用户主动关闭。
- 联网开关按聊天会话持久化，新会话默认关闭。
- URL 自动识别和读取始终启用，与联网开关无关。
- 首版原生搜索只支持 OpenAI Responses API。
- 现有 OpenAI-compatible Chat Completions 提供商继续用于普通聊天，但不宣称支持原生搜索。
- 原生搜索不可用时，每次发送最多显示一次轻提示，并继续普通对话。
- 不提供第三方搜索 API、SearXNG 或搜索结果页抓取。

## 3. 方案选择

### 3.1 采用：URL Reader + OpenAI Responses 原生搜索

两项能力分开实现：

- `UrlReader` 读取用户明确提供的公开网页，是确定性的服务端预处理。
- `OpenAIResponsesAdapter` 在联网开关开启时向 Responses API 声明原生 Web Search 工具，由模型决定查询内容和调用次数。

两条路径最终都输出统一的外部来源记录，供聊天界面展示和消息持久化。

该方案不要求 Sion 或客户维护通用搜索服务，并且不会把搜索能力错误地假设成 OpenAI-compatible 的公共标准。

### 3.2 不采用：客户配置第三方搜索 API

Tavily、Brave、Google、百度、博查等服务的认证、查询参数和响应结构不同。为辅助能力维护大量适配器会扩大设置和运维成本，不符合本次范围。

### 3.3 不采用：抓取搜索结果页

直接抓取 Google、百度等结果页容易遇到验证码、封禁、页面改版和合规风险，不能作为稳定的产品能力。

### 3.4 不采用：自动判断何时搜索

搜索会产生额外费用并把外部信息带入项目。用户已经选择用显式开关控制，不再由模型或关键词隐式启用搜索。

## 4. 核心数据模型

### 4.1 模型提供商协议

`ModelProvider` 增加显式协议类型：

```ts
type ModelProviderProtocol = "chat_completions" | "openai_responses";

type ModelProvider = {
  // existing fields
  protocol: ModelProviderProtocol;
};
```

- 读取旧配置时，缺失的 `protocol` 迁移为 `chat_completions`，保证现有请求行为不变。
- `chat_completions` 继续使用现有 URL 解析和流式解析逻辑。
- `openai_responses` 使用独立请求、流式事件和引用解析器。
- 是否支持原生搜索由协议能力决定，不根据模型名称猜测。

### 4.2 会话联网偏好

```ts
type ChatSession = {
  // existing fields
  webSearchEnabled: boolean;
};
```

- 新会话默认 `false`。
- 读取旧会话索引时缺失值视为 `false`。
- 用户切换开关后立即持久化到当前会话；聊天请求不再提交第二份开关状态，服务端只读取已保存的会话设置。
- 切换会话时加载各自设置；切换模型不自动改变设置。

### 4.3 外部来源

```ts
type ExternalSource = {
  id: string;
  kind: "provided_url" | "web_search";
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  retrievedAt: string;
};

type ChatMessage = {
  // existing fields
  sources?: ExternalSource[];
};
```

- URL Reader 与原生搜索统一输出 `ExternalSource[]`。
- URL 规范化后按最终 URL 去重。
- `snippet` 只保存用于回答和界面展示的短摘要，不把整页正文重复写入聊天记录。
- 成功提供给模型的来源随 Assistant 消息一起持久化，历史会话可以恢复来源列表；不推断模型是否采纳了某条来源。

### 4.4 外部证据分类

`NodeMarkdownPatch.evidence` 扩展为可追溯的联合类型：

```ts
type PatchEvidence =
  | { source: "user" | "assistant"; quote: string }
  | { source: "external"; quote: string; sourceId: string };
```

外部来源产生的内容只能归入 `assumption` 或 `open_question`；只有用户在后续消息中明确确认，才允许以该用户消息作为证据生成 `confirmed_fact`。`sourceId` 必须指向本轮 Assistant 消息中已保存的 `ExternalSource`。

## 5. 请求与数据流

### 5.1 用户切换联网状态

1. 输入栏工具区显示地球图标开关。
2. 用户切换后，前端调用会话设置 endpoint 保存 `webSearchEnabled`。
3. 保存失败时恢复原状态并显示一次非阻塞错误。
4. 创建新会话、切换会话或刷新页面时，从会话数据恢复开关。

联网状态不是全局偏好，也不会在发送消息后自动关闭。

### 5.2 URL 自动读取

1. 聊天 route 从本轮用户消息中提取 `http/https` URL。
2. URL 规范化、去重并限制为最多 3 个；超出部分不读取，但保留在原始用户消息中。
3. `UrlReader` 并行读取允许的 URL，并为每个 URL 生成成功或失败结果。
4. 成功读取的页面转换为带明确边界的“不可信外部材料”，附加到本轮模型上下文。
5. 单个 URL 失败不取消其他读取，也不阻断聊天。
6. 成功提供给模型的 URL 以来源记录保存并展示，不声称模型一定采纳了页面内容。

URL Reader 不使用浏览器 Cookie、不执行页面脚本、不填写表单，也不访问登录态内容。

### 5.3 原生 Web Search

当 `webSearchEnabled=true` 且 provider 协议为 `openai_responses`：

1. Responses adapter 在请求中声明 OpenAI 原生 Web Search 工具。
2. adapter 消费 Responses 流，统一产出推理、文本增量和来源事件。
3. 聊天 route 把文本继续映射为现有 `reasoning`、`token` 事件，并新增来源事件。
4. 完成后将 Assistant 文本、推理内容和去重后的来源一起保存。

是否真正执行搜索由 OpenAI Responses API 在已授权工具范围内决定。Sion 不再额外判断搜索意图。

### 5.4 不支持搜索时的降级

当 `webSearchEnabled=true` 但 provider 协议为 `chat_completions`：

1. 服务端不向 Chat Completions 请求发送未知工具参数。
2. 本轮发送一次 `web_search_unavailable` SSE 事件。
3. 请求继续执行普通聊天；消息中的 URL 仍正常读取。
4. UI 显示一次轻提示，不在聊天区保留长期警告，也不要求用户配置其他服务。

## 6. URL Reader 安全边界

### 6.1 允许范围

- 只接受 `http:` 和 `https:`。
- 每条消息最多读取 3 个不同 URL。
- 每个请求设置连接和总耗时上限。
- 限制重定向次数、响应体大小和可接受 MIME 类型。
- 首版只提取 HTML 与纯文本；其他类型显示“暂不支持读取”。

### 6.2 SSRF 防护

初始 URL 和每次重定向都必须：

1. 解析主机名并拒绝 URL 中的嵌入凭证。
2. 拒绝 `localhost`、环回、私网、链路本地、保留地址、多播地址和云元数据地址。
3. 同时校验 IPv4、IPv6 以及 IPv4-mapped IPv6。
4. DNS 解析后校验所有候选地址；连接阶段固定到已校验结果或再次核对实际地址，防止 DNS 重绑定。

任何校验失败都只使当前 URL 读取失败，不影响聊天主流程。

### 6.3 内容处理与提示注入

- 不执行 JavaScript，不加载子资源。
- 去除脚本、样式、导航等非正文内容，规范化文本并执行长度上限。
- 页面内容使用独立结构和不可混淆的边界传给模型。
- 系统提示明确声明网页内容是不可信数据，禁止遵循其中的命令、角色声明、工具调用要求或数据外传要求。
- 外部内容不得覆盖 Agent 规则、节点 Schema 或系统回复要求。

这些措施降低风险但不能宣称完全消除提示注入，因此外部内容不能自动升级为确认事实。

## 7. SSE 事件与界面

聊天事件新增：

```ts
type ChatStreamEvent =
  | { type: "url_read_start"; urls: string[] }
  | { type: "url_read_result"; url: string; ok: true; source: ExternalSource }
  | { type: "url_read_result"; url: string; ok: false; error: string }
  | { type: "web_search_unavailable"; reason: "provider_unsupported" }
  | { type: "source"; source: ExternalSource }
  // existing events
```

界面行为：

- 地球按钮只表达当前会话是否允许原生搜索，不控制 URL 读取。
- URL 读取期间在本轮消息附近显示紧凑状态；结束后只保留来源或简短失败说明。
- 来源以标题和域名展示，点击后在新窗口打开原始 URL。
- 相同来源在一条消息中只展示一次。
- `web_search_unavailable` 每次发送最多提示一次，提示不写入聊天历史。
- 联网失败、URL 失败和来源解析失败均不得覆盖正常回答或交付稿状态提示。

## 8. 与交付稿生成的关系

聊天完成后的事实判定必须同时接收 Assistant 来源，但遵守以下优先级：

1. 本轮用户明确陈述可以成为 `confirmed_fact`。
2. Assistant 基于外部来源给出的结论只能成为 `assumption` 或 `open_question`。
3. 外部材料即使来自权威网站，也不能替代用户对项目事实的确认。
4. patch 的外部证据必须引用已保存的 `ExternalSource`，不能只保存无法追溯的文本片段。

URL 读取或搜索失败不改变现有 Markdown 生成流程；事实判定仍可基于用户消息和普通 Assistant 回复运行。

## 9. 错误处理

- 会话联网设置保存失败：回滚开关并提示，不发送错误状态下的新请求。
- 单个 URL 失败：记录该 URL 的简短失败原因，继续其他 URL 和聊天。
- 全部 URL 失败：继续普通聊天。
- Responses 原生搜索失败但仍可继续生成文本：保留已生成文本和有效来源，提示搜索部分失败。
- Responses 请求整体失败：沿用现有模型请求错误处理。
- provider 不支持原生搜索：发送一次能力提示，继续 Chat Completions。
- 客户端中断：终止 URL 请求和模型请求；沿用现有部分 Assistant 消息保存语义，但不得在中断后追加尚未发送给客户端的文本或来源。

对外错误不得包含 API Key、完整内部地址、DNS 解析结果或网页正文。

## 10. 测试策略

### 10.1 数据与迁移

- 旧 provider 缺失 `protocol` 时迁移为 `chat_completions`。
- 旧 session 缺失 `webSearchEnabled` 时迁移为 `false`。
- 消息来源可以保存、读取和去重。
- 不同会话保持独立联网状态。

### 10.2 LLM 适配器

- Chat Completions 请求保持现有请求体和流式行为。
- Responses 请求仅在开关开启时声明 Web Search 工具。
- Responses 文本、推理和来源事件可以跨网络 chunk 正确解析。
- 重复引用合并为单一 `ExternalSource`。
- provider 不支持时不会发送未知参数，并产生非阻断提示。

### 10.3 URL Reader

- URL 提取、尾随标点清理、规范化、去重和最多 3 个限制。
- HTML 与纯文本正文提取。
- 不支持的 MIME、超时、超大响应和重定向超限。
- 初始地址和重定向目标的 SSRF 校验。
- IPv4、IPv6、IPv4-mapped IPv6、DNS 多地址和 DNS 重绑定场景。
- 网页内提示指令被作为不可信文本隔离。
- 部分或全部 URL 失败时聊天仍能完成。

### 10.4 API 与 UI

- 开关切换持久化、失败回滚、刷新恢复和会话切换。
- 开关不会在发送后自动关闭。
- URL 读取不受联网开关影响。
- 来源列表、失败状态和不支持提示的展示与去重。
- 客户端中断同时取消网页读取和模型流。
- 外部来源不能被事实判定为 `confirmed_fact`。

## 11. 非目标

首版不包含：

- 第三方搜索 API 配置或由 Sion 托管的搜索服务。
- SearXNG 或其他自建搜索聚合服务。
- Google、百度等搜索结果页抓取。
- Anthropic、Gemini 或其他厂商的原生搜索适配器。
- 根据消息内容自动打开联网搜索。
- 登录态网页、Cookie、浏览器自动化、页面交互或 JavaScript 渲染。
- PDF、Office 文件和媒体 URL 的在线解析。
- 定时搜索、后台研究任务、搜索结果缓存或跨会话来源知识库。

## 12. 验收标准

- 旧模型配置和旧会话无需手工迁移即可继续使用。
- 用户粘贴公开网页 URL 后，无论联网开关状态如何，Agent 都能引用读取成功的页面内容并展示来源。
- 联网开关在当前会话内持续保持，直到用户主动关闭。
- OpenAI Responses provider 在开关开启时可以使用原生 Web Search 并展示来源。
- Chat Completions provider 在开关开启时只显示一次轻提示，普通聊天与 URL 读取仍成功。
- 私网、环回、云元数据及重定向到这些地址的请求均被阻止。
- 外部内容不能自动写成已确认项目事实。
- 任一外部能力失败都不应阻断不依赖该能力的正常聊天。
