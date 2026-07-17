# Sion 工作台导航与交付稿预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将 Sion 项目工作台改为固定 12 节点目录、聊天记录抽屉、单一右侧工作面和默认交付稿预览，同时建立 Codex 风格语义图标并保持现有数据安全边界。

**Architecture:** 保留 App.tsx 作为 Tauri 命令和领域状态协调器，把固定节点选择、瞬态右侧工作面、交付稿视图模式抽成可测试的纯状态函数。React 组件只重组展示；Rust 仅增加一个复用现有运行时规则拼接逻辑的只读 Agent 规则查询，不改变项目存储、Agent 调度、CAS 保存或导出。

**Tech Stack:** React 19.2、TypeScript 5.9、Vite 8、Tauri 2.11、Rust 2024、Node 内置 test runner、react-markdown、remark-gfm、现有 CSS token 与 Tauri IPC 封装。

## Global Constraints

- 新项目数据只写入 <projects directory>/<project id>/；节点写入继续保持原子性和 CAS revision。
- 全局应用设置只保存在 ~/.sion/；API Key 不得进入项目数据、日志、导出或 IPC 摘要。
- React 不读取本地文件系统，也不直接访问模型网络；所有原生能力通过 src/api.ts 中的 Tauri invoke 封装。
- 桌面运行时不得增加浏览器搜索、浏览器自动化、Playwright 或 Web egress。
- Agent 输出和 delivery patch 验证、预览、应用及取消行为保持不变。
- 12 个节点保持 NODES 定义的固定顺序，不显示节点图标，不提供关闭节点或“全部节点”选择器。
- 顶部功能顺序固定为交付稿、agent.md、文件池、更多；前三项显示单色线性语义图标。
- 所有用户可见的“资料”统一改为“文件池”；后端附件字段和存储路径不迁移。
- Markdown 预览不得执行原始 HTML，不得自动加载远程图片或其他外部资源。
- 不修改当前用户未提交的 crates/sion-core/src/lib.rs。
- 不修改项目数据、导出、local projects/、~/.sion/ 或 settings/ 内容。

---

## File Structure

| Path | 实施后职责 |
|---|---|
| src/types.ts | 保留持久 UI wire shape，新增 EffectiveAgentRules、RightSurface 和 DeliveryView 类型。 |
| src/ui-state.ts | 固定节点选择、旧设置规范化、瞬态工作面初始化与节点切换重置。 |
| src/workspace-config.ts | 顶部操作和主导航的稳定顺序、文案与图标名。 |
| src/markdown-policy.ts | Markdown URL 阻断策略和图片占位文案，供组件与 Node 测试共享。 |
| src/components/ui/Icon.tsx | 类型安全的内部单色 SVG 图标集合。 |
| src/components/workspace/MarkdownPreview.tsx | 安全的 CommonMark/GFM 阅读视图，不执行 HTML 或外部资源。 |
| src/components/workspace/DeliveryWorkspace.tsx | 交付稿预览/源文件、保存、revision 和导出。 |
| src/components/workspace/AgentRulesWorkspace.tsx | 内置、自定义和生效规则的展示与自定义规则保存。 |
| src/components/workspace/FilePoolWorkspace.tsx | 文件池列表、导入、上下文勾选和文件预览入口。 |
| src/components/workspace/ConversationHistoryDrawer.tsx | 当前节点会话列表、新建和切换。 |
| src/components/workspace/RightWorkspacePane.tsx | 单一右侧工作面、关闭、宽度拖动和紧凑覆盖。 |
| src/components/workspace/ProjectWorkspace.tsx | 固定顶部操作、聊天工具栏、更多菜单和中央/右侧组合。 |
| src/components/app/Sidebar.tsx | 项目列表和当前项目固定 12 节点纯文字目录。 |
| src/components/app/AppShell.tsx | Shell、搜索、通知；移除节点选择器和空节点状态。 |
| src/App.tsx | 领域数据协调、RightSurface 路由、节点切换重置和新组件接线。 |
| src-tauri/src/lib.rs | EffectiveAgentRules DTO、共享规则拼接函数、只读 Tauri 命令和 Rust 测试。 |
| tests/ui-state.test.ts | 固定节点、旧设置和瞬态工作面纯状态测试。 |
| tests/workspace-config.test.ts | 顶部操作顺序、图标语义和节点无图标契约。 |
| tests/markdown-policy.test.ts | Markdown URL 阻断和图片占位策略。 |
| src/styles/workspace.css | 新工作台、抽屉、单一右侧面板、预览、规则和文件池样式。 |
| src/styles/shell.css | 固定节点目录、项目语义图标和首页项目图标。 |
| src/styles/primitives.css | Icon 基础尺寸、分段按钮和紧凑图标按钮。 |
| src/styles/responsive.css | 1080px 右侧覆盖、960px 侧栏和紧凑顶部按钮。 |

删除以下不再使用的组件：

- src/components/app/NodePickerDialog.tsx
- src/components/workspace/WorkspaceTabs.tsx
- src/components/workspace/DeliveryTab.tsx
- src/components/workspace/ProjectFilesTab.tsx
- src/components/workspace/AgentRuleDialog.tsx

FilePreviewTab.tsx 和 DeliveryPreviewTab.tsx 保留，但改造成 RightWorkspacePane 内的子工作面并增加明确返回动作。

---

### Task 1: 固定节点与瞬态工作面状态

**Files:**
- Modify: src/types.ts
- Modify: src/ui-state.ts
- Modify: tests/ui-state.test.ts

**Interfaces:**
- Consumes: NODES、NodeId、ProjectUiSettings、UiSettings。
- Produces: RightSurface、DeliveryView、WorkspaceView、initialWorkspaceView()、selectNode()、resetWorkspaceViewForNode()、sanitizeUiSettings()、durableUiSettings()。

- [ ] **Step 1: 用固定节点和工作面测试替换旧分页测试**

在 tests/ui-state.test.ts 中删除 closeNode、openNode、closeRightTab、openRightTab 相关导入和测试，加入：

~~~ts
import {
  createSerialTaskQueue,
  durableUiSettings,
  filterAndSortProjects,
  initialProjectUi,
  initialWorkspaceView,
  requestNavigationDecision,
  requestScope,
  resetWorkspaceViewForNode,
  resolveNavigationDecision,
  sanitizeUiSettings,
  selectNode,
} from "../src/ui-state.ts";
import { NODES } from "../src/types.ts";

test("first project open initializes every node in fixed order and delivery preview", () => {
  const project = initialProjectUi();
  assert.deepEqual(project.openedNodeIds, NODES.map(([id]) => id));
  assert.equal(project.activeNodeId, "basic-info");
  assert.deepEqual(project.rightTabIds, ["delivery"]);
  assert.equal(project.activeRightTabId, "delivery");
  assert.deepEqual(initialWorkspaceView(), {
    rightSurface: { kind: "delivery" },
    deliveryView: "preview",
  });
});

test("selecting a node changes only the active node and never reorders the directory", () => {
  const selected = selectNode(initialProjectUi(), "goals");
  assert.equal(selected.activeNodeId, "goals");
  assert.deepEqual(selected.openedNodeIds, NODES.map(([id]) => id));
});

test("legacy opened nodes and tabs normalize to the fixed directory and delivery", () => {
  const sanitized = sanitizeUiSettings({
    sidebarCollapsed: false,
    lastDestination: "projects",
    projects: {
      project: {
        initialized: true,
        openedNodeIds: ["goals", "basic-info"],
        activeNodeId: "goals",
        tabsInitialized: true,
        rightTabIds: ["files", "file:old"],
        activeRightTabId: "file:old",
        rightPaneWidth: 9999,
      },
    },
  });
  assert.deepEqual(sanitized.projects.project.openedNodeIds, NODES.map(([id]) => id));
  assert.equal(sanitized.projects.project.activeNodeId, "goals");
  assert.deepEqual(sanitized.projects.project.rightTabIds, ["delivery"]);
  assert.equal(sanitized.projects.project.activeRightTabId, "delivery");
  assert.equal(sanitized.projects.project.rightPaneWidth, 720);
});

test("node change resets transient surfaces to delivery preview", () => {
  assert.deepEqual(
    resetWorkspaceViewForNode({
      rightSurface: { kind: "file", fileId: "brief" },
      deliveryView: "source",
    }),
    initialWorkspaceView(),
  );
});

test("durable settings never persist file or assistant preview surfaces", () => {
  const durable = durableUiSettings({
    sidebarCollapsed: false,
    lastDestination: "projects",
    projects: {
      project: {
        ...initialProjectUi(),
        rightTabIds: ["file:brief", "delivery-preview:message"],
        activeRightTabId: "file:brief",
      },
    },
  });
  assert.deepEqual(durable.projects.project.rightTabIds, ["delivery"]);
  assert.equal(durable.projects.project.activeRightTabId, "delivery");
});
~~~

- [ ] **Step 2: 运行测试并确认失败**

Run:

~~~bash
npm run test:ui
~~~

Expected: FAIL，因为 initialWorkspaceView、selectNode 和 resetWorkspaceViewForNode 尚未导出，且 initialProjectUi 仍只包含 basic-info。

- [ ] **Step 3: 增加瞬态工作面类型**

在 src/types.ts 中保留现有 ProjectUiSettings wire shape，并新增：

~~~ts
export type DeliveryView = "preview" | "source";

export type RightSurface =
  | { kind: "delivery" }
  | { kind: "agent-rules" }
  | { kind: "file-pool" }
  | { kind: "file"; fileId: string }
  | { kind: "delivery-preview"; messageId: string };

export type WorkspaceView = {
  rightSurface: RightSurface | null;
  deliveryView: DeliveryView;
};
~~~

- [ ] **Step 4: 实现固定目录和规范化**

在 src/ui-state.ts 中：

~~~ts
import type {
  NodeId,
  ProjectUiSettings,
  RecentProject,
  UiSettings,
  WorkspaceView,
} from "./types.ts";

const FIXED_NODE_IDS = NODES.map(([id]) => id);

export const initialWorkspaceView = (): WorkspaceView => ({
  rightSurface: { kind: "delivery" },
  deliveryView: "preview",
});

export const resetWorkspaceViewForNode = (_current: WorkspaceView): WorkspaceView =>
  initialWorkspaceView();

export const initialProjectUi = (): ProjectUiSettings => ({
  initialized: true,
  openedNodeIds: [...FIXED_NODE_IDS],
  activeNodeId: "basic-info",
  tabsInitialized: true,
  rightTabIds: ["delivery"],
  activeRightTabId: "delivery",
  rightPaneWidth: 440,
});

export const selectNode = (
  state: ProjectUiSettings,
  nodeId: NodeId,
): ProjectUiSettings => ({
  ...state,
  initialized: true,
  openedNodeIds: [...FIXED_NODE_IDS],
  activeNodeId: nodeId,
  tabsInitialized: true,
  rightTabIds: ["delivery"],
  activeRightTabId: "delivery",
});
~~~

把 sanitizeProjectUi 和 durableUiSettings 中的节点/右侧分页处理改为固定值：

~~~ts
function sanitizeProjectUi(value: ProjectUiSettings): ProjectUiSettings {
  const activeNodeId = isNodeId(value.activeNodeId) ? value.activeNodeId : "basic-info";
  return {
    initialized: true,
    openedNodeIds: [...FIXED_NODE_IDS],
    activeNodeId,
    tabsInitialized: true,
    rightTabIds: ["delivery"],
    activeRightTabId: "delivery",
    rightPaneWidth: Math.min(
      MAX_PANE_WIDTH,
      Math.max(MIN_PANE_WIDTH, Number(value.rightPaneWidth) || 440),
    ),
  };
}

export const durableUiSettings = (state: UiSettings): UiSettings =>
  sanitizeUiSettings(state);
~~~

删除 openNode、closeNode、openRightTab 和 closeRightTab。

- [ ] **Step 5: 运行纯状态测试**

Run:

~~~bash
npm run test:ui
~~~

Expected: PASS，所有 ui-state 和 popover-state 测试通过。

- [ ] **Step 6: 提交状态重构**

~~~bash
git add src/types.ts src/ui-state.ts tests/ui-state.test.ts
git commit -m "refactor(ui): stabilize node and workspace state"
~~~

---

### Task 2: 增加完整 Agent 规则只读查询

**Files:**
- Modify: src-tauri/src/lib.rs
- Modify: src/types.ts
- Modify: src/api.ts

**Interfaces:**
- Consumes: sion_core::agent_rule(node_id)、ProjectStore::agent_override(node_id)、ProjectNodeRequest。
- Produces: EffectiveAgentRules、compose_effective_agent_rules()、project_get_agent_rules Tauri command、getAgentRules(projectId, nodeId)。

- [ ] **Step 1: 先写 Rust 规则拼接测试**

在 src-tauri/src/lib.rs 的 tests 模块加入：

~~~rust
#[test]
fn effective_agent_rules_match_the_runtime_prompt_order() {
    let rules = compose_effective_agent_rules(
        WorkflowNodeId::Goals,
        Some("只使用已确认目标。".to_string()),
    );
    assert_eq!(rules.built_in_markdown, sion_core::agent_rule(WorkflowNodeId::Goals));
    assert_eq!(
        rules.custom_markdown.as_deref(),
        Some("只使用已确认目标。")
    );
    assert_eq!(
        rules.effective_markdown,
        format!(
            "{}\n\n# 项目覆盖规则\n只使用已确认目标。",
            sion_core::agent_rule(WorkflowNodeId::Goals)
        )
    );
}

#[test]
fn empty_agent_override_is_not_part_of_effective_rules() {
    let rules = compose_effective_agent_rules(
        WorkflowNodeId::BasicInfo,
        Some(" \n ".to_string()),
    );
    assert_eq!(rules.custom_markdown, None);
    assert_eq!(rules.effective_markdown, rules.built_in_markdown);
}
~~~

- [ ] **Step 2: 运行 focused Rust 测试并确认失败**

Run:

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml effective_agent_rules -- --nocapture
~~~

Expected: compilation FAIL，因为 compose_effective_agent_rules 和响应 DTO 尚不存在。

- [ ] **Step 3: 定义 DTO 和共享拼接函数**

在 src-tauri/src/lib.rs 中加入：

~~~rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectiveAgentRules {
    built_in_markdown: String,
    custom_markdown: Option<String>,
    effective_markdown: String,
}

fn compose_effective_agent_rules(
    node_id: WorkflowNodeId,
    custom_markdown: Option<String>,
) -> EffectiveAgentRules {
    let built_in_markdown = sion_core::agent_rule(node_id).to_string();
    let custom_markdown = custom_markdown
        .map(|markdown| markdown.trim().to_string())
        .filter(|markdown| !markdown.is_empty());
    let effective_markdown = custom_markdown
        .as_deref()
        .map(|custom| format!("{built_in_markdown}\n\n# 项目覆盖规则\n{custom}"))
        .unwrap_or_else(|| built_in_markdown.clone());
    EffectiveAgentRules {
        built_in_markdown,
        custom_markdown,
        effective_markdown,
    }
}
~~~

修改 agent_prompt：删除 override_block；在 attachment_block 前创建 effective_rules；把 format! 参数中连续的 sion_core::agent_rule(node.id) 和 override_block 两项替换为 effective_rules.effective_markdown。保留原 prompt 文本、delivery 指令、附件、节点 Markdown 和会话顺序不变。

- [ ] **Step 4: 增加并注册只读 Tauri 命令**

~~~rust
#[tauri::command]
fn project_get_agent_rules(
    request: ProjectNodeRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<EffectiveAgentRules>, ApiError> {
    assert_api_version(&request.version)?;
    let project_root = resolve_registered_project_root(&app, &request.project_id)?;
    let custom_markdown = ProjectStore::at(project_root)
        .agent_override(request.node_id)
        .map_err(|error| ApiError::CheckFailed(error.to_string()))?;
    Ok(VersionedResponse {
        api_version: API_VERSION,
        payload: compose_effective_agent_rules(request.node_id, custom_markdown),
    })
}
~~~

把 project_get_agent_rules 加入 tauri::generate_handler!，放在 project_get_node 和 project_get_agent_override 之间。

- [ ] **Step 5: 增加前端类型和 API**

在 src/types.ts 中加入：

~~~ts
export type EffectiveAgentRules = {
  builtInMarkdown: string;
  customMarkdown: string | null;
  effectiveMarkdown: string;
};
~~~

在 src/api.ts 的类型导入加入 EffectiveAgentRules，并加入：

~~~ts
export const getAgentRules = (projectId: string, nodeId: NodeId) =>
  invokePayload<EffectiveAgentRules>("project_get_agent_rules", { projectId, nodeId });
~~~

- [ ] **Step 6: 运行 Rust 和 TypeScript 验证**

Run:

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml effective_agent_rules -- --nocapture
npm run lint
~~~

Expected: Rust focused tests PASS；TypeScript 编译检查 PASS。

- [ ] **Step 7: 提交只读查询**

~~~bash
git add src-tauri/src/lib.rs src/types.ts src/api.ts
git commit -m "feat(agent): expose effective node rules"
~~~

---

### Task 3: 建立语义图标和固定节点侧栏

**Files:**
- Create: src/workspace-config.ts
- Create: src/components/ui/Icon.tsx
- Modify: src/components/ui/index.ts
- Modify: src/components/app/Sidebar.tsx
- Modify: src/components/app/AppShell.tsx
- Modify: src/components/app/GlobalSearchDialog.tsx
- Modify: src/components/app/ProjectHome.tsx
- Modify: src/components/app/ExportCenter.tsx
- Modify: src/styles/primitives.css
- Modify: src/styles/shell.css
- Delete: src/components/app/NodePickerDialog.tsx
- Create: tests/workspace-config.test.ts

**Interfaces:**
- Consumes: NODES、IconButton、UiSettings、RecentProject。
- Produces: IconName、Icon、PRIMARY_NAV_ITEMS、WORKSPACE_HEADER_ACTIONS、固定 Sidebar 节点目录。

- [ ] **Step 1: 写图标与操作顺序契约测试**

创建 tests/workspace-config.test.ts：

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import { NODES } from "../src/types.ts";
import {
  PRIMARY_NAV_ITEMS,
  WORKSPACE_HEADER_ACTIONS,
  WORKSPACE_NODE_ROWS,
} from "../src/workspace-config.ts";

test("workspace header actions have the approved order and distinct icons", () => {
  assert.deepEqual(
    WORKSPACE_HEADER_ACTIONS.map(({ id, label }) => [id, label]),
    [
      ["delivery", "交付稿"],
      ["agent-rules", "agent.md"],
      ["file-pool", "文件池"],
    ],
  );
  assert.equal(new Set(WORKSPACE_HEADER_ACTIONS.map(({ icon }) => icon)).size, 3);
});

test("primary navigation uses semantic icons", () => {
  assert.deepEqual(
    PRIMARY_NAV_ITEMS.map(({ id, label, icon }) => [id, label, icon]),
    [
      ["projects", "项目", "projects"],
      ["exports", "导出中心", "export"],
    ],
  );
});

test("node rows stay text-only and preserve the domain order", () => {
  assert.deepEqual(WORKSPACE_NODE_ROWS, NODES);
  assert.equal(WORKSPACE_NODE_ROWS.some((row) => row.length > 2), false);
});
~~~

- [ ] **Step 2: 运行测试并确认失败**

Run:

~~~bash
npm run test:ui
~~~

Expected: FAIL，因为 src/workspace-config.ts 尚不存在。

- [ ] **Step 3: 创建稳定配置**

创建 src/workspace-config.ts：

~~~ts
import { NODES } from "./types.ts";

export const ICON_NAMES = [
  "projects",
  "export",
  "settings",
  "project-document",
  "delivery",
  "agent",
  "file-pool",
  "chat-history",
  "run-history",
  "search",
  "sidebar-collapse",
  "sidebar-expand",
  "back",
  "close",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export const PRIMARY_NAV_ITEMS = [
  { id: "projects", label: "项目", icon: "projects" },
  { id: "exports", label: "导出中心", icon: "export" },
] as const;

export const WORKSPACE_HEADER_ACTIONS = [
  { id: "delivery", label: "交付稿", icon: "delivery" },
  { id: "agent-rules", label: "agent.md", icon: "agent" },
  { id: "file-pool", label: "文件池", icon: "file-pool" },
] as const;

export const WORKSPACE_NODE_ROWS = NODES;
~~~

- [ ] **Step 4: 创建内部 SVG Icon 组件**

创建 src/components/ui/Icon.tsx。每个图标使用 viewBox 0 0 24 24、fill none、stroke currentColor、strokeWidth 1.6、圆角端点。组件签名和受控路径表：

~~~tsx
import type { ReactNode, SVGProps } from "react";
import type { IconName } from "../../workspace-config.ts";

export function Icon({
  name,
  size = 16,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  const paths = {
    projects: <path d="M3.5 6.5h6l2 2h9v10h-17z" />,
    export: <><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5M4 19h16" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
    "project-document": <><path d="M5 3.5h9l5 5v12H5z" /><path d="M14 3.5v5h5M8 13h8M8 17h6" /></>,
    delivery: <><path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4" /><path d="m9 14 2 2 4-5" /></>,
    agent: <><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M9 12h.01M15 12h.01M8 8 6 6M16 8l2-2" /></>,
    "file-pool": <><path d="M3.5 6.5h6l2 2h9v10h-17z" /><path d="M8 13h8M12 10v6" /></>,
    "chat-history": <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h6" /></>,
    "run-history": <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" /></>,
    "sidebar-collapse": <path d="m14 6-6 6 6 6" />,
    "sidebar-expand": <path d="m10 6 6 6-6 6" />,
    back: <><path d="m10 6-6 6 6 6" /><path d="M4 12h16" /></>,
    close: <path d="m7 7 10 10M17 7 7 17" />,
  } satisfies Record<IconName, ReactNode>;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
~~~

从 src/components/ui/index.ts 导出 Icon。

- [ ] **Step 5: 重写 Sidebar 为固定纯文字节点**

移除 dirty、onCloseNode、onOpenNodePicker props。Sidebar 用 nodesCollapsed 保存当前项目的瞬态折叠状态，并在 activeProject?.id 改变时重置为 false，保证每次打开项目默认展开。项目行保留独立 disclosure IconButton 切换折叠；点击项目名称仍打开项目。展开时直接遍历 WORKSPACE_NODE_ROWS：

~~~tsx
{active && projectUi ? (
  <div
    className="sidebar-node-list"
    aria-label={item.name + " 工作流节点"}
    hidden={nodesCollapsed}
  >
    {WORKSPACE_NODE_ROWS.map(([id, title]) => {
      const selected =
        destination === "workspace" && projectUi.activeNodeId === id;
      return (
        <button
          aria-current={selected ? "page" : undefined}
          className={selected ? "sidebar-node is-active" : "sidebar-node"}
          key={id}
          onClick={() => onNode(id)}
          type="button"
        >
          {title}
        </button>
      );
    })}
  </div>
) : null}
~~~

主导航、项目根项、搜索、折叠和设置用 Icon；节点按钮内不渲染 Icon。

- [ ] **Step 6: 移除节点选择器并替换方块图标**

在 AppShell.tsx 删除 NodePickerDialog、nodePickerOpen、nodeStatuses、getNode 副作用、intentionalNodeEmpty 和 onCloseNode。

在 GlobalSearchDialog.tsx、ProjectHome.tsx、ExportCenter.tsx 中用：

~~~tsx
<Icon name="project-document" size={18} />
~~~

替换 □ 或缺失的项目图标。ExportCenter 的选中项目摘要在项目名左侧显示该图标；Word 格式的 W 图标继续表达导出格式，不与项目图标混用。

- [ ] **Step 7: 调整图标和节点 CSS**

在 primitives.css 加入 .ui-icon；在 shell.css 把 .sidebar-node 改为单个 button 规则，取消关闭按钮和 marker 布局。节点选中态同时使用 font-weight: 600、background: var(--bg-hover) 和 aria-current。

- [ ] **Step 8: 运行测试和构建检查**

Run:

~~~bash
npm run test:ui
npm run lint
npm run build
~~~

Expected: 全部 PASS；构建产物中不再引用 NodePickerDialog。

- [ ] **Step 9: 提交导航与图标**

~~~bash
git add src/workspace-config.ts src/components/ui/Icon.tsx src/components/ui/index.ts src/components/app/Sidebar.tsx src/components/app/AppShell.tsx src/components/app/GlobalSearchDialog.tsx src/components/app/ProjectHome.tsx src/components/app/ExportCenter.tsx src/styles/primitives.css src/styles/shell.css tests/workspace-config.test.ts
git add -u src/components/app/NodePickerDialog.tsx
git commit -m "feat(ui): add fixed workflow navigation"
~~~

---

### Task 4: 增加安全交付稿预览和源文件切换

**Files:**
- Modify: package.json
- Modify: package-lock.json
- Create: src/markdown-policy.ts
- Create: src/components/workspace/MarkdownPreview.tsx
- Create: src/components/workspace/DeliveryWorkspace.tsx
- Modify: src/styles/workspace.css
- Create: tests/markdown-policy.test.ts

**Interfaces:**
- Consumes: WorkflowNode、DeliveryView、statusLabel、Button、StatusDot。
- Produces: blockedMarkdownUrl()、markdownImageLabel()、MarkdownPreview、DeliveryWorkspace。

- [ ] **Step 1: 写 Markdown 安全策略测试**

创建 tests/markdown-policy.test.ts：

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedMarkdownUrl,
  markdownImageLabel,
} from "../src/markdown-policy.ts";

test("markdown preview blocks every navigable or loadable URL", () => {
  assert.equal(blockedMarkdownUrl("https://example.com/image.png"), "");
  assert.equal(blockedMarkdownUrl("file:///Users/test/secret.txt"), "");
  assert.equal(blockedMarkdownUrl("javascript:alert(1)"), "");
  assert.equal(blockedMarkdownUrl("/relative/path"), "");
});

test("markdown images become readable non-loading placeholders", () => {
  assert.equal(markdownImageLabel("架构图"), "[图片：架构图]");
  assert.equal(markdownImageLabel(""), "[图片：未命名]");
  assert.equal(markdownImageLabel(undefined), "[图片：未命名]");
});
~~~

- [ ] **Step 2: 运行测试并确认失败**

Run:

~~~bash
npm run test:ui
~~~

Expected: FAIL，因为 src/markdown-policy.ts 尚不存在。

- [ ] **Step 3: 实现策略并安装官方渲染器**

创建 src/markdown-policy.ts：

~~~ts
export const blockedMarkdownUrl = (_url: string): string => "";

export const markdownImageLabel = (alt: string | undefined): string =>
  "[图片：" + (alt?.trim() || "未命名") + "]";
~~~

Run:

~~~bash
npm install react-markdown remark-gfm
~~~

Expected: package.json 和 package-lock.json 更新。react-markdown 官方文档确认默认不使用 dangerouslySetInnerHTML，并支持 components、remarkPlugins、skipHtml 和 urlTransform；remark-gfm 提供表格、任务列表和删除线。

- [ ] **Step 4: 创建安全 MarkdownPreview**

创建 src/components/workspace/MarkdownPreview.tsx：

~~~tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  blockedMarkdownUrl,
  markdownImageLabel,
} from "../../markdown-policy.ts";

export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={blockedMarkdownUrl}
        components={{
          a: ({ children }) => <span className="markdown-link-text">{children}</span>,
          img: ({ alt }) => (
            <span className="markdown-image-placeholder">
              {markdownImageLabel(alt)}
            </span>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
~~~

- [ ] **Step 5: 创建 DeliveryWorkspace**

创建 src/components/workspace/DeliveryWorkspace.tsx，props 为：

~~~tsx
type DeliveryWorkspaceProps = {
  node: WorkflowNode | null;
  nodeTitle: string;
  markdown: string;
  view: DeliveryView;
  dirty: boolean;
  saving: boolean;
  exporting: boolean;
  onView: (view: DeliveryView) => void;
  onMarkdown: (value: string) => void;
  onSave: () => void;
  onExport: () => void;
};
~~~

头部使用 role="tablist" 和两个 role="tab" 按钮切换 preview/source。主体精确分支：

~~~tsx
{view === "preview" ? (
  <MarkdownPreview markdown={markdown} />
) : (
  <textarea
    aria-label={nodeTitle + " Markdown 源文件编辑器"}
    disabled={!node}
    spellCheck={false}
    value={markdown}
    onChange={(event) => onMarkdown(event.target.value)}
  />
)}
~~~

footer 保留字符数、脏状态、保存和导出 DOCX；保存按钮只在 dirty 且 node 可用时启用。

- [ ] **Step 6: 增加预览、表格、代码和分段按钮样式**

在 workspace.css 添加 .delivery-workspace、.delivery-view-switch、.markdown-preview、table、pre、code、blockquote、.markdown-link-text 和 .markdown-image-placeholder。预览容器 overflow-y: auto；源文件 textarea 使用现有等宽字体和焦点样式。

- [ ] **Step 7: 运行安全策略和前端构建**

Run:

~~~bash
npm run test:ui
npm run lint
npm run build
~~~

Expected: 全部 PASS；构建不包含 rehype-raw；Markdown 组件不渲染 href 或 img src。

- [ ] **Step 8: 提交交付稿工作面**

~~~bash
git add package.json package-lock.json src/markdown-policy.ts src/components/workspace/MarkdownPreview.tsx src/components/workspace/DeliveryWorkspace.tsx src/styles/workspace.css tests/markdown-policy.test.ts
git commit -m "feat(delivery): add safe preview and source views"
~~~

---

### Task 5: 构建单一右侧工作面、agent.md 和文件池

**Files:**
- Create: src/components/workspace/RightWorkspacePane.tsx
- Create: src/components/workspace/AgentRulesWorkspace.tsx
- Create: src/components/workspace/FilePoolWorkspace.tsx
- Modify: src/components/workspace/FilePreviewTab.tsx
- Modify: src/components/workspace/DeliveryPreviewTab.tsx
- Modify: src/styles/workspace.css

**Interfaces:**
- Consumes: RightSurface、EffectiveAgentRules、ProjectFile、FilePreview、AssistantDeliveryPreview、DeliveryWorkspace。
- Produces: RightWorkspacePane、AgentRulesWorkspace、FilePoolWorkspace；file/delivery preview 的 onBack 行为。

- [ ] **Step 1: 在 ui-state 测试增加子工作面返回契约**

在 tests/ui-state.test.ts 加入：

~~~ts
import { parentSurface } from "../src/ui-state.ts";

test("nested right surfaces return to their owning workspace", () => {
  assert.deepEqual(
    parentSurface({ kind: "file", fileId: "brief" }),
    { kind: "file-pool" },
  );
  assert.deepEqual(
    parentSurface({ kind: "delivery-preview", messageId: "message" }),
    { kind: "delivery" },
  );
  assert.equal(parentSurface({ kind: "delivery" }), null);
});
~~~

- [ ] **Step 2: 运行测试并确认失败**

Run:

~~~bash
npm run test:ui
~~~

Expected: FAIL，因为 parentSurface 尚未导出。

- [ ] **Step 3: 实现 parentSurface**

在 src/ui-state.ts 加入：

~~~ts
import type { RightSurface } from "./types.ts";

export function parentSurface(surface: RightSurface): RightSurface | null {
  if (surface.kind === "file") return { kind: "file-pool" };
  if (surface.kind === "delivery-preview") return { kind: "delivery" };
  return null;
}
~~~

- [ ] **Step 4: 创建 RightWorkspacePane**

RightWorkspacePane 复用 WorkspaceTabs 的 pointer/keyboard resize 算法，但不渲染 TabList。props：

~~~tsx
type RightWorkspacePaneProps = {
  title: string;
  paneWidth: number;
  onClose: () => void;
  onPaneWidth: (width: number) => void;
  children: ReactNode;
};
~~~

面板头部只显示 title 和带 Icon name="close" 的 IconButton。separator 保留 aria-valuemin=320、aria-valuemax=720、ArrowLeft、ArrowRight、Home 和 End 行为。

- [ ] **Step 5: 创建 AgentRulesWorkspace**

组件 props：

~~~tsx
type AgentRulesWorkspaceProps = {
  rules: EffectiveAgentRules | null;
  loading: boolean;
  saving: boolean;
  customDraft: string;
  onCustomDraft: (value: string) => void;
  onSave: () => void;
  onRetry: () => void;
};
~~~

使用三个明确 section：内置规则 pre（只读）、自定义规则 textarea、完整生效规则 pre（只读）。loading 时显示“正在读取 agent.md…”；rules 为 null 且非 loading 时显示 EmptyState 和“重试”。

- [ ] **Step 6: 创建 FilePoolWorkspace 并统一文案**

把 ProjectFilesTab 的逻辑迁移到 FilePoolWorkspace，所有可见文案改为：

~~~tsx
<h2>文件池</h2>
<p>选择需要提供给当前节点 Agent 的本地文件。</p>
<EmptyState
  title="文件池为空"
  description="导入的文件会复制到当前项目，并仅通过受限文本预览读取。"
  action={{ label: "导入文件", onClick: onImport }}
/>
~~~

FilePreviewTab 增加 onBack prop 和“返回文件池”按钮；文件缺失说明改为“该文件已不在文件池中”。DeliveryPreviewTab 增加 onBack prop，取消和应用成功后的父级状态由 App 控制。

- [ ] **Step 7: 添加面板和工作面样式**

在 workspace.css 删除 tabs header 依赖，新增 .right-workspace-pane、.right-workspace-header、.agent-rules-workspace、.agent-rule-section、.file-pool-workspace。只读规则和文件预览使用 overflow: auto；自定义规则编辑器最小高度 180px。

- [ ] **Step 8: 运行测试和构建**

Run:

~~~bash
npm run test:ui
npm run lint
npm run build
~~~

Expected: 全部 PASS。

- [ ] **Step 9: 提交右侧工作面**

~~~bash
git add src/ui-state.ts tests/ui-state.test.ts src/components/workspace/RightWorkspacePane.tsx src/components/workspace/AgentRulesWorkspace.tsx src/components/workspace/FilePoolWorkspace.tsx src/components/workspace/FilePreviewTab.tsx src/components/workspace/DeliveryPreviewTab.tsx src/styles/workspace.css
git commit -m "feat(workspace): add focused right-side surfaces"
~~~

---

### Task 6: 移动聊天记录并重构顶部功能

**Files:**
- Create: src/components/workspace/ConversationHistoryDrawer.tsx
- Modify: src/workspace-config.ts
- Modify: tests/workspace-config.test.ts
- Modify: src/components/workspace/ProjectWorkspace.tsx
- Modify: src/components/workspace/ConversationPane.tsx
- Modify: src/styles/workspace.css

**Interfaces:**
- Consumes: ChatSession、AgentRun、RightSurface、WORKSPACE_HEADER_ACTIONS、Icon、Popover。
- Produces: ConversationHistoryDrawer；固定顶部操作；更多菜单中的运行记录；聊天区工具栏。

- [ ] **Step 1: 扩展工作台配置测试以锁定运行记录位置**

在 tests/workspace-config.test.ts 加入：

~~~ts
import { MORE_MENU_ITEMS } from "../src/workspace-config.ts";

test("run history lives in more instead of the primary header actions", () => {
  assert.deepEqual(MORE_MENU_ITEMS, [
    { id: "run-history", label: "运行记录", icon: "run-history" },
  ]);
  assert.equal(
    WORKSPACE_HEADER_ACTIONS.some(({ id }) => id === "run-history"),
    false,
  );
});
~~~

- [ ] **Step 2: 运行测试并确认失败**

Run:

~~~bash
npm run test:ui
~~~

Expected: FAIL，因为 MORE_MENU_ITEMS 尚不存在。

- [ ] **Step 3: 增加更多菜单配置**

在 src/workspace-config.ts 加入：

~~~ts
export const MORE_MENU_ITEMS = [
  { id: "run-history", label: "运行记录", icon: "run-history" },
] as const;
~~~

- [ ] **Step 4: 创建 ConversationHistoryDrawer**

props：

~~~tsx
type ConversationHistoryDrawerProps = {
  open: boolean;
  sessions: ChatSession[];
  sessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onClose: () => void;
};
~~~

根元素用 role="dialog"、aria-modal="false" 和 aria-label="聊天记录"。打开时聚焦关闭按钮；Escape 调用 onClose；选择会话后先 onSelect 再 onClose。空状态文案为“当前节点还没有聊天记录。”

- [ ] **Step 5: 重写 ProjectWorkspace 头部**

删除顶部会话 Popover、运行 Popover、onOpenDelivery 和 onOpenMaterials。新增 props：

~~~tsx
rightSurface: RightSurface | null;
onRightSurface: (surface: RightSurface) => void;
~~~

按 WORKSPACE_HEADER_ACTIONS 渲染三个 Button，每个 Button 同时包含 Icon 和 label，用 aria-pressed 表示当前工作面，并设置 data-workspace-action={action.id}，供右侧面板关闭后恢复焦点。更多 Popover 固定包含运行记录：

~~~tsx
<Popover label="更多节点操作" trigger={<span aria-hidden="true">•••</span>}>
  <div className="workspace-overflow-menu">
    <section aria-label="运行记录">
      <h3><Icon name="run-history" />运行记录</h3>
      {runs.length === 0 ? (
        <p>还没有运行记录。</p>
      ) : runs.slice(0, 8).map((run) => (
        <div className="run-history-row" key={run.id}>
          <StatusDot kind={runStatusKind(run.status)} />
          <span>
            <strong>{run.nodeId}</strong>
            <small>{runLabel[run.status]}</small>
          </span>
        </div>
      ))}
    </section>
  </div>
</Popover>
~~~

- [ ] **Step 6: 把聊天记录移入聊天区工具栏**

ProjectWorkspace 内新增 historyOpen state 和 historyTriggerRef，并在 node?.id 变化时关闭。使用统一 closeHistory 恢复触发器焦点：

~~~tsx
const historyTriggerRef = useRef<HTMLButtonElement>(null);

function closeHistory() {
  setHistoryOpen(false);
  window.requestAnimationFrame(() => historyTriggerRef.current?.focus());
}
~~~

workspace-conversation 中先渲染：

~~~tsx
<div className="conversation-toolbar">
  <Button
    ref={historyTriggerRef}
    variant="ghost"
    onClick={() => setHistoryOpen(true)}
  >
    <Icon name="chat-history" />
    聊天记录
  </Button>
  <Button variant="secondary" onClick={props.onCreateSession}>
    ＋ 新会话
  </Button>
</div>
~~~

然后渲染 ConversationPane 和 ConversationHistoryDrawer，并把 closeHistory 传给 drawer 的 onClose。ConversationPane 的运行中说明与停止按钮保持原逻辑。

- [ ] **Step 7: 增加抽屉和紧凑头部样式**

workspace.css 添加 .conversation-toolbar、.conversation-history-backdrop、.conversation-history-drawer、.run-history-row 和 .workspace-action-label。抽屉 position: absolute、inset: 40px auto 0 0、宽 300px，仅覆盖 .workspace-conversation。

- [ ] **Step 8: 运行测试和构建**

Run:

~~~bash
npm run test:ui
npm run lint
npm run build
~~~

Expected: 全部 PASS；ProjectWorkspace 中不再出现“选择会话”或“查看 Agent 运行” Popover。

- [ ] **Step 9: 提交聊天与头部重构**

~~~bash
git add src/workspace-config.ts tests/workspace-config.test.ts src/components/workspace/ConversationHistoryDrawer.tsx src/components/workspace/ProjectWorkspace.tsx src/components/workspace/ConversationPane.tsx src/styles/workspace.css
git commit -m "feat(chat): move history into conversation workspace"
~~~

---

### Task 7: 在 App 中接线并删除旧分页组件

**Files:**
- Modify: src/App.tsx
- Modify: src/components/app/AppShell.tsx
- Modify: src/ui-state.ts
- Modify: tests/ui-state.test.ts
- Delete: src/components/workspace/WorkspaceTabs.tsx
- Delete: src/components/workspace/DeliveryTab.tsx
- Delete: src/components/workspace/ProjectFilesTab.tsx
- Delete: src/components/workspace/AgentRuleDialog.tsx

**Interfaces:**
- Consumes: selectNode、initialWorkspaceView、resetWorkspaceViewForNode、getAgentRules、saveAgentOverride、RightWorkspacePane 及所有右侧工作面。
- Produces: 完整运行中的固定节点工作台；节点切换默认交付稿预览；瞬态右侧工作面不持久化。

- [ ] **Step 1: 先增加节点导航重置测试**

在 tests/ui-state.test.ts 加入：

~~~ts
test("same-node selection preserves the current transient workspace", () => {
  const current = {
    rightSurface: { kind: "agent-rules" } as const,
    deliveryView: "preview" as const,
  };
  assert.equal(
    resetWorkspaceViewForNode(current, { sameNode: true }),
    current,
  );
});
~~~

把已有 node change 测试改为：

~~~ts
assert.deepEqual(
  resetWorkspaceViewForNode(
    {
      rightSurface: { kind: "file", fileId: "brief" },
      deliveryView: "source",
    },
    { sameNode: false },
  ),
  initialWorkspaceView(),
);
~~~

- [ ] **Step 2: 运行测试并确认失败**

Run:

~~~bash
npm run test:ui
~~~

Expected: TypeScript compilation FAIL，因为 resetWorkspaceViewForNode 还没有 options 参数。

- [ ] **Step 3: 精确实现同节点与跨节点行为**

在 src/ui-state.ts 更新：

~~~ts
export const resetWorkspaceViewForNode = (
  current: WorkspaceView,
  options: { sameNode: boolean },
): WorkspaceView => options.sameNode ? current : initialWorkspaceView();
~~~

- [ ] **Step 4: 在 App 增加瞬态工作面和 Agent 规则状态**

新增 state：

~~~tsx
const [workspaceView, setWorkspaceView] = useState(initialWorkspaceView);
const [agentRules, setAgentRules] = useState<EffectiveAgentRules | null>(null);
const [loadingAgentRules, setLoadingAgentRules] = useState(false);
~~~

用 loadAgentRules 替换 loadAgentOverride：

~~~tsx
async function loadAgentRules(projectId: string, nextNodeId: NodeId) {
  const scope = requestScope(projectId, nextNodeId);
  setLoadingAgentRules(true);
  setAgentRules(null);
  try {
    const loaded = await getAgentRules(projectId, nextNodeId);
    if (workspaceScopeRef.current !== scope) return;
    setAgentRules(loaded);
    setAgentOverride(loaded.customMarkdown);
    setAgentOverrideDraft(loaded.customMarkdown ?? "");
  } catch (error) {
    if (workspaceScopeRef.current !== scope) return;
    setNotice("读取 agent.md 失败：" + String(error));
  } finally {
    if (workspaceScopeRef.current === scope) setLoadingAgentRules(false);
  }
}
~~~

保存自定义规则成功后重新调用 loadAgentRules，保持三个规则视图一致。删除 agentOverrideOpen、openAgentOverride、setAgentOverrideOpen 和 AgentRuleDialog 相关状态/函数；保留 agentOverrideDraft 和 savingAgentOverride。

- [ ] **Step 5: 重写节点和项目打开流程**

openProjectImmediate 在进入项目时执行：

~~~tsx
setWorkspaceView(initialWorkspaceView());
~~~

selectNodeImmediate 使用 selectNode，不再清除或关闭节点：

~~~tsx
function selectNodeImmediate(id: NodeId) {
  if (!project) return;
  const sameNode = id === activeNodeId;
  if (!sameNode) {
    setNode(null);
    setDraft("");
  }
  setDeliveryPreview(null);
  setFilePreview(null);
  setWorkspaceView((current) =>
    resetWorkspaceViewForNode(current, { sameNode }),
  );
  const current = ui.projects[project.id] ?? initialProjectUi();
  workspaceScopeRef.current = requestScope(project.id, id);
  messageScopeRef.current = null;
  updateUi({
    ...ui,
    projects: {
      ...ui.projects,
      [project.id]: selectNode(current, id),
    },
  });
  setDestination("workspace");
}
~~~

删除 closeNodeImmediate、closeWorkspaceTab、openWorkspaceTab 和 selectWorkspaceTab。

- [ ] **Step 6: 构建单一 rightWorkPane 分支**

按 workspaceView.rightSurface.kind 选择组件：

~~~tsx
const rightWorkContent =
  workspaceView.rightSurface?.kind === "delivery" ? (
    <DeliveryWorkspace
      node={node}
      nodeTitle={nodeTitle}
      markdown={draft}
      view={workspaceView.deliveryView}
      dirty={dirty}
      saving={saving}
      exporting={exporting}
      onView={(deliveryView) =>
        setWorkspaceView((current) => ({ ...current, deliveryView }))
      }
      onMarkdown={setDraft}
      onSave={() => void saveNodeDraft()}
      onExport={() => { if (project) void exportDocx(project.id); }}
    />
  ) : workspaceView.rightSurface?.kind === "agent-rules" ? (
    <AgentRulesWorkspace
      rules={agentRules}
      loading={loadingAgentRules}
      saving={savingAgentOverride}
      customDraft={agentOverrideDraft}
      onCustomDraft={setAgentOverrideDraft}
      onSave={() => void saveAgentOverrideDraft()}
      onRetry={() => {
        if (project && activeNodeId) {
          void loadAgentRules(project.id, activeNodeId);
        }
      }}
    />
  ) : workspaceView.rightSurface?.kind === "file-pool" ? (
    <FilePoolWorkspace
      files={files}
      selectedFileIds={selectedFileIds}
      importing={importingFile}
      onImport={() => void importFile()}
      onToggleContext={toggleFileContext}
      onPreview={(fileId) => {
        setWorkspaceView((current) => ({
          ...current,
          rightSurface: { kind: "file", fileId },
        }));
        void selectFilePreview(fileId);
      }}
    />
  ) : null;
~~~

补齐 file 和 delivery-preview 分支，onBack 分别回到 file-pool 和 delivery。RightWorkspacePane 在 rightSurface 为 null 时不渲染。

同时改写三个仍使用旧 openWorkspaceTab 的流程：

~~~tsx
// previewAssistant 成功
setDeliveryPreview(preview);
setWorkspaceView((current) => ({
  ...current,
  rightSurface: {
    kind: "delivery-preview",
    messageId: preview.assistantMessageId,
  },
}));

// importFile 成功并返回文件
setWorkspaceView((current) => ({
  ...current,
  rightSurface: { kind: "file", fileId: result.file!.id },
}));
void selectFilePreview(result.file.id);

// applyAssistant 成功或冲突、以及取消修改预览
setDeliveryPreview(null);
setWorkspaceView({
  rightSurface: { kind: "delivery" },
  deliveryView: "preview",
});
~~~

为 RightWorkspacePane 提供稳定标题：

~~~tsx
function rightSurfaceTitle(surface: RightSurface): string {
  if (surface.kind === "delivery") return "交付稿";
  if (surface.kind === "agent-rules") return "agent.md";
  if (surface.kind === "file-pool") return "文件池";
  if (surface.kind === "file") {
    return files.find((file) => file.id === surface.fileId)?.originalName ?? "文件预览";
  }
  return "Assistant 修改预览";
}
~~~

- [ ] **Step 7: 接线 ProjectWorkspace 与 AppShell**

ProjectWorkspace 接收 rightSurface、onRightSurface 和 workPane。顶部操作设置 RightSurface。关闭右侧时先记住父功能入口，清空 rightSurface，再恢复对应按钮焦点：

~~~tsx
function closeRightSurface() {
  const surface = workspaceView.rightSurface;
  const action = surface?.kind === "file"
    ? "file-pool"
    : surface?.kind === "delivery-preview"
      ? "delivery"
      : surface?.kind;
  setWorkspaceView((current) => ({ ...current, rightSurface: null }));
  if (action) {
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-workspace-action="' + action + '"]',
        )
        ?.focus();
    });
  }
}
~~~

AppShell 删除 onCloseNode prop。App 传入的 onNode 继续走 requestNavigation，以保留 dirty guard。

- [ ] **Step 8: 删除旧组件和导入**

删除 WorkspaceTabs、DeliveryTab、ProjectFilesTab、AgentRuleDialog 文件及 App.tsx 导入。运行：

~~~bash
rg -n "WorkspaceTabs|DeliveryTab|ProjectFilesTab|AgentRuleDialog|closeNodeImmediate|openWorkspaceTab" src
~~~

Expected: 无输出。

- [ ] **Step 9: 运行完整前端验证**

Run:

~~~bash
npm run test:ui
npm run lint
npm run build
~~~

Expected: 全部 PASS。

- [ ] **Step 10: 提交应用集成**

~~~bash
git add src/App.tsx src/components/app/AppShell.tsx src/ui-state.ts tests/ui-state.test.ts
git add -u src/components/workspace/WorkspaceTabs.tsx src/components/workspace/DeliveryTab.tsx src/components/workspace/ProjectFilesTab.tsx src/components/workspace/AgentRuleDialog.tsx
git commit -m "refactor(workspace): integrate focused project surfaces"
~~~

---

### Task 8: 响应式、可访问性与最终验证

**Files:**
- Modify: src/styles/responsive.css
- Modify: src/styles/workspace.css
- Modify: src/styles/shell.css
- Modify: docs/superpowers/specs/2026-07-17-sion-workspace-navigation-preview-design.md

**Interfaces:**
- Consumes: 前七个任务完成的工作台。
- Produces: 1080px 覆盖式右面板、960px 可用布局、最终验证记录和完成状态规格。

- [ ] **Step 1: 添加紧凑布局 CSS**

responsive.css 使用以下规则替换旧 workspace-side-pane 选择器：

~~~css
@media (max-width: 1080px) {
  .right-workspace-pane {
    position: fixed;
    z-index: 40;
    inset: 0 0 0 auto;
    width: min(520px, calc(100vw - 48px));
    max-width: none;
    box-shadow: -16px 0 48px rgb(0 0 0 / 10%);
  }
  .right-workspace-resizer { display: none; }
}

@media (max-width: 960px) {
  .app-shell { grid-template-columns: 232px minmax(0, 1fr); }
  .app-shell.is-sidebar-collapsed { grid-template-columns: 0 minmax(0, 1fr); }
  .workspace-action-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
}
~~~

- [ ] **Step 2: 做键盘和无障碍静态检查**

检查以下准确契约：

- Sidebar 当前节点有 aria-current="page"。
- 三个顶部 Button 有 aria-pressed。
- 只显示图标时仍保留 aria-label 和 title。
- ConversationHistoryDrawer 的关闭按钮可聚焦，Escape 关闭并把焦点还给“聊天记录”触发器。
- RightWorkspacePane separator 支持 ArrowLeft、ArrowRight、Home、End。
- 面板关闭后 ProjectWorkspace 把焦点返回对应顶部入口。
- MarkdownPreview 不渲染 href、src 或 dangerouslySetInnerHTML。

Run:

~~~bash
rg -n "dangerouslySetInnerHTML|rehypeRaw|href=|src=" src/components/workspace/MarkdownPreview.tsx
~~~

Expected: 无输出。

- [ ] **Step 3: 运行所有自动检查**

Run:

~~~bash
npm run lint
npm run build
npm run test:ui
npm run test:rust
cargo test --workspace
cargo clippy --workspace -- -D warnings
~~~

Expected: 所有命令退出码 0。src-tauri 是独立 workspace，npm run test:rust 覆盖它；根 cargo 命令覆盖 sion-core、sion-storage 和 sion-agent。

- [ ] **Step 4: 运行静态边界检查**

Run:

~~~bash
npm run test:no-browser-runtime
npm run test:no-legacy-migration-runtime
npm run test:storage-contract
rg -n "资料|选择会话|查看 Agent 运行|全部节点|关闭.*节点|□" src
~~~

Expected: 三个静态脚本 PASS；最后的 rg 无用户可见旧文案或方块图标命中。若内部变量或注释包含“资料”，只允许在不会进入 UI 的后端兼容命名中存在。

- [ ] **Step 5: 执行桌面视觉 QA**

Run:

~~~bash
npm run tauri dev
~~~

在原生窗口逐项检查并记录结果：

1. 首页项目行和导出中心项目摘要使用 project-document 线性图标。
2. 打开项目后 12 个节点全部展开、纯文字、顺序固定；折叠项目后再次打开项目会恢复展开。
3. 依次点击 goals、basic-info、final-export，条目位置不变。
4. 有未保存源文件时切节点，保存/放弃/取消对话框仍工作。
5. 聊天记录按钮打开只覆盖中央区域的抽屉；选择会话后关闭。
6. 顶部严格显示交付稿、agent.md、文件池和三点更多。
7. 更多菜单显示运行记录；活动运行仍可从 composer 停止。
8. 交付稿默认预览；源文件修改后切回预览立即反映。
9. Markdown 中的原始 HTML 不执行，远程图片不发起加载。
10. agent.md 显示内置、自定义和生效规则，只能编辑自定义区域。
11. 文件池导入、上下文勾选、预览和返回均工作。
12. 把窗口缩到约 960px，右面板覆盖中央区且顶部按钮仍有 tooltip。

- [ ] **Step 6: 把规格状态改为已实现**

仅在以上自动检查和视觉 QA 全部通过后，把设计文档状态改为：

~~~markdown
**状态：** 已实现并验证
~~~

- [ ] **Step 7: 提交最终适配与验证**

~~~bash
git add src/styles/responsive.css src/styles/workspace.css src/styles/shell.css docs/superpowers/specs/2026-07-17-sion-workspace-navigation-preview-design.md
git commit -m "test(ui): verify workspace navigation refresh"
~~~

---

## Completion Gate

实施完成前必须同时满足：

- 8 个任务均有独立提交且测试通过。
- git status 不包含本计划之外的新修改；用户原有 crates/sion-core/src/lib.rs 修改保持原样。
- 设计规格的验收标准均可映射到 Task 1–8 的测试或视觉 QA。
- 未引入浏览器运行时、网络预览、原始 HTML 执行或项目数据迁移。
- 未实现用户明确排除的节点图标、项目个性化图标、暗色主题或新导出格式。
