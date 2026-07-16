# Sion Codex-Style UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Sion's complete frontend UI as a light Codex-style desktop shell with a project hub, closable opened nodes, central conversation, optional right work tabs, unified dialogs and controls, and safe dirty-navigation behavior.

**Architecture:** Keep Rust/Tauri authoritative for settings, projects, nodes, files, Agent runs, delivery patches, and export. Extend native application settings with bounded presentation state, then replace the landing/workbench split with a persistent React `AppShell`; focused child components render the project hub, settings, conversation, work tabs, and export center. `App.tsx` remains the native-command and domain-state coordinator.

**Tech Stack:** React 19, TypeScript 5.9, Vite 8, Tauri 2.11, Rust 2024, serde/serde_json, Node 22 built-in test runner, existing Rust tests and native desktop visual QA.

**Spec:** `docs/superpowers/specs/2026-07-16-sion-codex-ui-redesign-design.md`

## Global Constraints

- New project data is written only through the Rust storage boundary; React never reads or writes the local filesystem.
- API keys remain behind the existing provider/credential boundary and are never returned to React in plaintext.
- The desktop runtime gains no browser search, browser automation, Playwright, or web-egress subsystem.
- Existing CAS node saves, delivery preview-before-apply, Agent streaming/cancellation, bounded file preview, and DOCX export behavior remain intact.
- The UI is light-only. Do not add a dark theme, account, avatar, login, user profile, or sidebar version label.
- The sidebar bottom contains Settings only. Top-level destinations are Projects and Export Center.
- Project home uses roomy list rows, not project cards or analytics widgets.
- Opened-node close removes only UI state; it never deletes node data.
- Closing the final right tab collapses the right pane; closing the final opened node shows `选择节点` without silently reopening a node.
- All native request/response payloads remain versioned with `apiVersion: 1`.
- Do not commit generated project data, exports, local `projects/`, local settings content, or `.superpowers/` mockup artifacts.

---

## File Structure

| Path | Responsibility after implementation |
|---|---|
| `src-tauri/src/app_settings.rs` | Atomic global settings plus bounded persisted UI presentation state. |
| `src-tauri/src/lib.rs` | `settings_save_ui`, project reveal command, and existing versioned native commands. |
| `src/types.ts` | Domain DTOs plus UI settings, destinations, durable tab IDs, and shared component contracts. |
| `src/api.ts` | Typed wrappers for native settings UI persistence and project reveal. |
| `src/ui-state.ts` | Pure initialization, sanitization, opened-node, tab, and active-selection transitions. |
| `tests/ui-state.test.ts` | Node built-in tests for loss-sensitive UI transitions, kept outside the browser TypeScript build. |
| `src/App.tsx` | Domain/native coordinator and composition root for the persistent shell. |
| `src/components/app/AppShell.tsx` | Persistent sidebar/main layout and global overlay slots. |
| `src/components/app/Sidebar.tsx` | Destinations, all-project scrolling, opened nodes, collapse, and Settings. |
| `src/components/app/GlobalSearchDialog.tsx` | Search all projects and the active project's workflow nodes. |
| `src/components/app/ProjectHome.tsx` | Searchable/sortable roomy project list and empty/configuration states. |
| `src/components/app/NewProjectDialog.tsx` | Centered project creation form. |
| `src/components/app/ExportCenter.tsx` | Existing DOCX export flow presented as a shell destination. |
| `src/components/settings/SettingsDialog.tsx` | Large General/Models settings dialog. |
| `src/components/settings/ProviderEditorDialog.tsx` | Add/edit provider medium dialog with inline validation. |
| `src/components/workspace/ProjectWorkspace.tsx` | Workspace header, conversation, right pane, and compact overlay layout. |
| `src/components/workspace/ConversationPane.tsx` | Sessions, run popover, messages, composer, streaming, and cancellation. |
| `src/components/workspace/WorkspaceTabs.tsx` | Durable/transient right-tab lifecycle and resizing. |
| `src/components/workspace/DeliveryTab.tsx` | Markdown draft, save/export metadata, and custom-rule entry. |
| `src/components/workspace/ProjectFilesTab.tsx` | File list, context selection, import, and preview opening. |
| `src/components/workspace/FilePreviewTab.tsx` | One bounded local extracted-text preview. |
| `src/components/workspace/DeliveryPreviewTab.tsx` | Assistant patch statistics, preview, cancel, and apply. |
| `src/components/workspace/AgentRuleDialog.tsx` | Large node-specific custom-rule editor. |
| `src/components/ui/*.tsx` | Button, Dialog, Field, Feedback, Popover, and Tabs primitives. |
| `src/styles/*.css` | Tokens, primitives, shell, workspace, dialogs, and responsive rules. |
| `src/styles.css` | Ordered imports only. |

Delete the old `LandingPage.tsx`, `Workbench.tsx`, `FilePreviewPane.tsx`, root-level `SettingsDialog.tsx`, and `ProviderManager.tsx` only after their replacements are wired and verified.

---

### Task 1: Persist Bounded UI State and Reveal Projects Natively

**Files:**
- Modify: `src-tauri/src/app_settings.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/app_settings.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: existing `sion_root`, `resolve_registered_project_root`, `AppSettings`, and versioned command envelope.
- Produces: `UiSettings`, `ProjectUiSettings`, `settings_save_ui`, and `project_reveal` returning `ProjectRevealResult { revealed: bool }`.

- [ ] **Step 1: Add failing backward-compatibility and persistence tests**

Add these tests to `app_settings.rs`:

```rust
#[test]
fn old_settings_json_defaults_ui_state() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("settings.json"),
        r#"{"schemaVersion":1,"projectsDirectory":null}"#,
    )
    .unwrap();
    let loaded = load(&root).unwrap();
    assert_eq!(loaded.ui, UiSettings::default());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn saves_and_reloads_bounded_ui_state() {
    let root = temp_root();
    let mut settings = AppSettings::with_projects_directory(None);
    settings.ui.sidebar_collapsed = true;
    settings.ui.last_destination = "exports".to_string();
    settings.ui.projects.insert(
        "project-1".to_string(),
        ProjectUiSettings {
            initialized: true,
            opened_node_ids: vec!["basic-info".to_string()],
            active_node_id: Some("basic-info".to_string()),
            tabs_initialized: true,
            right_tab_ids: vec!["delivery".to_string()],
            active_right_tab_id: Some("delivery".to_string()),
            right_pane_width: 460,
        },
    );
    save(&root, settings.clone()).unwrap();
    assert_eq!(load(&root).unwrap().ui, settings.ui);
    let _ = fs::remove_dir_all(root);
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml app_settings::tests:: -- --nocapture
```

Expected: compilation fails because `UiSettings`, `ProjectUiSettings`, and `AppSettings.ui` do not exist.

- [ ] **Step 3: Add the serializable native UI settings model**

Add this exact public model above `AppSettings`:

```rust
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSettings {
    pub sidebar_collapsed: bool,
    pub last_destination: String,
    pub projects: BTreeMap<String, ProjectUiSettings>,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            sidebar_collapsed: false,
            last_destination: "projects".to_string(),
            projects: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectUiSettings {
    pub initialized: bool,
    pub opened_node_ids: Vec<String>,
    pub active_node_id: Option<String>,
    pub tabs_initialized: bool,
    pub right_tab_ids: Vec<String>,
    pub active_right_tab_id: Option<String>,
    pub right_pane_width: u16,
}

impl Default for ProjectUiSettings {
    fn default() -> Self {
        Self {
            initialized: false,
            opened_node_ids: Vec::new(),
            active_node_id: None,
            tabs_initialized: false,
            right_tab_ids: Vec::new(),
            active_right_tab_id: None,
            right_pane_width: 440,
        }
    }
}
```

Add `#[serde(default)] pub ui: UiSettings` to `AppSettings`, initialize it in `with_projects_directory`, and normalize before every save/load:

```rust
fn normalize_ui(mut ui: UiSettings) -> UiSettings {
    if !matches!(ui.last_destination.as_str(), "projects" | "exports") {
        ui.last_destination = "projects".to_string();
    }
    ui.projects = ui.projects.into_iter().filter(|(id, _)| id.len() <= 128).take(256).map(|(id, mut project)| {
        project.opened_node_ids.retain(|id| id.len() <= 64);
        project.opened_node_ids.truncate(12);
        project.right_tab_ids.retain(|id| id.len() <= 512);
        project.right_tab_ids.truncate(32);
        project.right_pane_width = project.right_pane_width.clamp(320, 720);
        (id, project)
    }).collect();
    ui
}
```

- [ ] **Step 4: Preserve UI state when the project directory changes**

In both directory commands, mutate the loaded settings rather than constructing a fresh value:

```rust
let mut updated = settings;
updated.projects_directory = Some(directory);
let updated = app_settings::save(&global, updated).map_err(ApiError::CheckFailed)?;
```

For clear, set `projects_directory = None` on the loaded value. Add an app-settings test asserting `ui` survives both mutations.

- [ ] **Step 5: Add versioned settings-save and project-reveal commands**

Extend `SettingsSummary` with `ui: app_settings::UiSettings`. Add:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSaveUiRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    ui: app_settings::UiSettings,
}

#[tauri::command]
fn settings_save_ui(
    request: SettingsSaveUiRequest,
    app: tauri::AppHandle,
) -> Result<VersionedResponse<SettingsSummary>, ApiError> {
    assert_api_version(&request.version)?;
    let global = sion_root(&app)?;
    let mut settings = app_settings::load(&global).map_err(ApiError::CheckFailed)?;
    settings.ui = request.ui;
    let saved = app_settings::save(&global, settings).map_err(ApiError::CheckFailed)?;
    Ok(VersionedResponse { api_version: API_VERSION, payload: settings_summary(&saved) })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRevealRequest {
    #[serde(flatten)]
    version: VersionedRequest,
    project_id: String,
}
```

Implement `project_reveal` by resolving the registered project root, then spawning `open <path>` on macOS or `explorer <path>` on Windows. Return a bounded unsupported-platform `ApiError` elsewhere. Register both commands in `generate_handler!`.

Return a concrete payload rather than a flattened `void` payload:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRevealResult {
    revealed: bool,
}
```

- [ ] **Step 6: Run native verification**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml app_settings::tests:: -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml tests:: -- --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: all tests pass and Clippy reports no warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/app_settings.rs src-tauri/src/lib.rs
git commit -m "feat(settings): persist desktop UI state"
```

---

### Task 2: Add the Typed Frontend UI State Reducer

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.app.json`
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Create: `src/ui-state.ts`
- Create: `tests/ui-state.test.ts`

**Interfaces:**
- Consumes: native `UiSettings` JSON from Task 1 and `NODES`/`NodeId`.
- Produces: `initialProjectUi`, `sanitizeUiSettings`, `openNode`, `closeNode`, `openRightTab`, `closeRightTab`, and `durableUiSettings`.

- [ ] **Step 1: Add the Node test script and failing reducer tests**

Add to `package.json`:

```json
"test:ui": "node --test --experimental-strip-types tests/ui-state.test.ts"
```

Add `"allowImportingTsExtensions": true` to `tsconfig.app.json` because the same state module is loaded by Vite and directly by Node's TypeScript stripping runtime.

Create `tests/ui-state.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  closeNode,
  closeRightTab,
  durableUiSettings,
  initialProjectUi,
  openNode,
  openRightTab,
} from "../src/ui-state.ts";

test("first project open initializes basic info and delivery", () => {
  assert.deepEqual(initialProjectUi(), {
    initialized: true,
    openedNodeIds: ["basic-info"],
    activeNodeId: "basic-info",
    tabsInitialized: true,
    rightTabIds: ["delivery"],
    activeRightTabId: "delivery",
    rightPaneWidth: 440,
  });
});

test("closing the last node preserves an intentional empty state", () => {
  const state = closeNode(initialProjectUi(), "basic-info");
  assert.deepEqual(state.openedNodeIds, []);
  assert.equal(state.activeNodeId, null);
  assert.equal(state.initialized, true);
});

test("closing active node selects the most recent remaining node", () => {
  let state = openNode(initialProjectUi(), "goals");
  state = openNode(state, "business-flow");
  state = closeNode(state, "business-flow");
  assert.equal(state.activeNodeId, "goals");
});

test("closing the final right tab keeps tabs initialized and empty", () => {
  const state = closeRightTab(initialProjectUi(), "delivery");
  assert.deepEqual(state.rightTabIds, []);
  assert.equal(state.activeRightTabId, null);
});

test("transient preview tabs are excluded from persisted settings", () => {
  const state = openRightTab(initialProjectUi(), "delivery-preview:message-1");
  const durable = durableUiSettings({
    sidebarCollapsed: false,
    lastDestination: "projects",
    projects: { p1: state },
  });
  assert.deepEqual(durable.projects.p1.rightTabIds, ["delivery"]);
});
```

- [ ] **Step 2: Run tests and verify module-not-found failure**

Run `npm run test:ui`.

Expected: FAIL because `src/ui-state.ts` does not exist.

- [ ] **Step 3: Define the exact frontend state types**

Add to `src/types.ts`:

```ts
export type MainDestination = "projects" | "exports" | "workspace";
export type DurableRightTabId = "delivery" | "files" | `file:${string}`;
export type TransientRightTabId = `delivery-preview:${string}`;
export type RightTabId = DurableRightTabId | TransientRightTabId;

export type ProjectUiSettings = {
  initialized: boolean;
  openedNodeIds: NodeId[];
  activeNodeId: NodeId | null;
  tabsInitialized: boolean;
  rightTabIds: RightTabId[];
  activeRightTabId: RightTabId | null;
  rightPaneWidth: number;
};

export type UiSettings = {
  sidebarCollapsed: boolean;
  lastDestination: Exclude<MainDestination, "workspace">;
  projects: Record<string, ProjectUiSettings>;
};

export type AppSettings = {
  projectsDirectory: string | null;
  ui: UiSettings;
};
```

- [ ] **Step 4: Implement the pure reducer**

Create `src/ui-state.ts` and import runtime values with `import { NODES } from "./types.ts"`. Use `NODES` to validate node IDs, clamp pane width to `320..720`, deduplicate arrays, keep most-recent items at the end, and implement these exact signatures:

```ts
export const initialProjectUi = (): ProjectUiSettings;
export const initialUiSettings = (): UiSettings;
export const sanitizeUiSettings = (value: UiSettings): UiSettings;
export const openNode = (state: ProjectUiSettings, nodeId: NodeId): ProjectUiSettings;
export const closeNode = (state: ProjectUiSettings, nodeId: NodeId): ProjectUiSettings;
export const openRightTab = (state: ProjectUiSettings, tabId: RightTabId): ProjectUiSettings;
export const closeRightTab = (state: ProjectUiSettings, tabId: RightTabId): ProjectUiSettings;
export const durableUiSettings = (state: UiSettings): UiSettings;
```

`durableUiSettings` must remove every `delivery-preview:*` tab and repair an active transient tab to the last remaining durable tab or `null`.

- [ ] **Step 5: Add typed native wrappers**

Add to `src/api.ts`:

```ts
export const saveUiSettings = (ui: UiSettings) =>
  invokePayload<AppSettings>("settings_save_ui", { ui: durableUiSettings(ui) });

export const revealProject = (projectId: string) =>
  invokePayload<{ revealed: boolean }>("project_reveal", { projectId });
```

Import `UiSettings` and `durableUiSettings`. Keep components unaware of `invoke`.

- [ ] **Step 6: Run frontend verification**

Run:

```bash
npm run test:ui
npm run lint
npm run build
```

Expected: reducer tests pass; TypeScript and Vite complete successfully.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.app.json src/types.ts src/api.ts src/ui-state.ts tests/ui-state.test.ts
git commit -m "feat(ui): model persistent workspace state"
```

---

### Task 3: Establish Design Tokens and Accessible UI Primitives

**Files:**
- Create: `src/components/ui/Button.tsx`
- Create: `src/components/ui/Dialog.tsx`
- Create: `src/components/ui/Field.tsx`
- Create: `src/components/ui/Feedback.tsx`
- Create: `src/components/ui/Popover.tsx`
- Create: `src/components/ui/Tabs.tsx`
- Create: `src/components/ui/index.ts`
- Create: `src/styles/tokens.css`
- Create: `src/styles/primitives.css`
- Create: `src/styles/shell.css`
- Create: `src/styles/workspace.css`
- Create: `src/styles/dialogs.css`
- Create: `src/styles/responsive.css`
- Replace: `src/styles.css`

**Interfaces:**
- Produces: shared `Button`, `IconButton`, `Dialog`, `Field`, `SelectField`, `EmptyState`, `Notice`, `StatusDot`, `Popover`, `TabList`, and `Tab`.

- [ ] **Step 1: Create a failing UI barrel contract**

Create `src/components/ui/index.ts` first:

```ts
export { Button, IconButton } from "./Button";
export { Dialog } from "./Dialog";
export { Field, SelectField } from "./Field";
export { EmptyState, Notice, StatusDot } from "./Feedback";
export { Popover } from "./Popover";
export { Tab, TabList } from "./Tabs";
```

Run `npm run lint`.

Expected: FAIL with missing-module errors for each primitive.

- [ ] **Step 2: Implement button and field primitives**

Use these public contracts:

```tsx
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
};

export function Button({ variant = "secondary", loading = false, disabled, children, className = "", ...props }: ButtonProps) {
  return <button className={`ui-button ui-button-${variant} ${className}`} disabled={disabled || loading} {...props}>{loading ? "处理中…" : children}</button>;
}

export function IconButton({ "aria-label": ariaLabel, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  if (!ariaLabel) throw new Error("IconButton requires aria-label");
  return <button className={`ui-icon-button ${className}`} aria-label={ariaLabel} {...props} />;
}
```

`Field` and `SelectField` accept `label`, `error`, and `hint`, generate stable IDs with `useId`, and connect `aria-describedby`/`aria-invalid` to the rendered control.

- [ ] **Step 3: Implement dialog, popover, feedback, and tab primitives**

`Dialog` must render through `createPortal(document.body)`, focus the first focusable child, trap `Tab`, close on safe `Escape`, restore trigger focus, and expose:

```tsx
type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  size?: "confirm" | "short" | "medium" | "large";
  closeLabel: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
};
```

`Popover` uses a button trigger, closes on outside pointer/Escape, and assigns `aria-expanded`. `TabList` uses `role="tablist"`; `Tab` uses `role="tab"`, arrow-key traversal, visible keyboard-focusable close actions, and no `Cmd/Ctrl+W` interception.

- [ ] **Step 4: Replace global CSS with ordered design layers**

Make `src/styles.css` contain only:

```css
@import "./styles/tokens.css";
@import "./styles/primitives.css";
@import "./styles/shell.css";
@import "./styles/workspace.css";
@import "./styles/dialogs.css";
@import "./styles/responsive.css";
```

Define tokens in `tokens.css`:

```css
:root {
  --bg-sidebar: #f5f5f4;
  --bg-main: #ffffff;
  --bg-subtle: #f7f7f6;
  --bg-hover: #ececea;
  --text: #292929;
  --text-muted: #858585;
  --border: #e2e2df;
  --primary: #252525;
  --success: #258456;
  --warning: #b66a32;
  --danger: #c74343;
  --focus: #4c78dd;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  color: var(--text);
  background: var(--bg-main);
}
```

Remove serif typography, gradients, large decorative color blocks, and component-specific button palettes.

- [ ] **Step 5: Verify primitives compile and render**

Run:

```bash
npm run lint
npm run build
```

Expected: PASS. Start `npm run tauri dev` and inspect a temporary primitive usage in Settings: primary, secondary, ghost, danger, focus ring, disabled, and loading states all match the token system. Remove the temporary usage before commit.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui src/styles src/styles.css
git commit -m "feat(ui): add Codex-style design primitives"
```

---

### Task 4: Build the Persistent App Shell and Sidebar

**Files:**
- Create: `src/components/app/AppShell.tsx`
- Create: `src/components/app/Sidebar.tsx`
- Create: `src/components/app/NodePickerDialog.tsx`
- Create: `src/components/app/GlobalSearchDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/types.ts`
- Modify: `src/styles/shell.css`

**Interfaces:**
- Consumes: `UiSettings`, all projects, active project, node titles, and state transition callbacks.
- Produces: a stable shell around all main destinations.

- [ ] **Step 1: Change `App.tsx` to import the nonexistent shell and verify failure**

Add:

```tsx
import { AppShell } from "./components/app/AppShell";
```

Run `npm run lint`.

Expected: FAIL because `AppShell.tsx` does not exist.

- [ ] **Step 2: Implement the shell and sidebar contracts**

`AppShell` accepts:

```ts
type AppShellProps = {
  destination: MainDestination;
  projects: RecentProject[];
  activeProject: RecentProject | null;
  ui: UiSettings;
  dirty: boolean;
  onDestination: (destination: "projects" | "exports") => void;
  onProject: (project: RecentProject) => void;
  onNode: (nodeId: NodeId) => void;
  onCloseNode: (nodeId: NodeId) => void;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenNodePicker: () => void;
  children: React.ReactNode;
};
```

`Sidebar` renders Projects and Export Center, every project in a locally scrollable region, only the active project's opened nodes, an `全部节点` action, a search IconButton, and Settings at the bottom. Node close is a labeled `IconButton`; dirty state uses a text-supported status dot.

- [ ] **Step 3: Implement node selection and final-node empty state**

`NodePickerDialog` lists all 12 `NODES`, supports local text search, includes each loaded status when available, and calls `onSelect(nodeId)`. If the active project's persisted `activeNodeId` is `null`, `AppShell` renders a `选择节点` empty state in the main region rather than calling `getNode`.

When the node picker opens, load summaries with `Promise.allSettled(NODES.map(([id]) => getNode(project.id, id)))`; show successful statuses and keep failed rows selectable with an unavailable status. `GlobalSearchDialog` searches every project name plus the active project's 12 node titles. Selecting a project opens it; selecting a node opens it in the active project.

- [ ] **Step 4: Wire shell state without replacing domain actions**

Initialize frontend UI state from `getSettings().ui`. Keep `project`, `node`, `draft`, sessions, files, runs, and native actions in `App.tsx`. Replace the early `if (!project)` return with one `AppShell` return whose child is selected from destination/project state.

Replace the raw notice string with this shared value:

```ts
export type NoticeMessage = {
  id: string;
  kind: "success" | "warning" | "error";
  message: string;
  dismissAfterMs: number | null;
};
```

`AppShell` renders the shared Notice viewport. Success uses `dismissAfterMs: 4000`; warnings and errors use `null`. Save success stays inline and does not create repeated notifications.

- [ ] **Step 5: Verify compile and shell behavior**

Run `npm run test:ui`, `npm run lint`, and `npm run build`.

Then run `npm run tauri dev` and verify: sidebar is stable, all projects scroll, active project alone expands, sidebar collapses, Settings remains at bottom, and no user/version UI appears.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/types.ts src/components/app/AppShell.tsx src/components/app/Sidebar.tsx src/components/app/NodePickerDialog.tsx src/components/app/GlobalSearchDialog.tsx src/styles/shell.css
git commit -m "feat(ui): add persistent desktop shell"
```

---

### Task 5: Replace the Landing Page with the Project Hub

**Files:**
- Create: `src/components/app/ProjectHome.tsx`
- Create: `src/components/app/NewProjectDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/shell.css`
- Delete after verification: `src/components/LandingPage.tsx`

**Interfaces:**
- Consumes: projects, settings, providers, creation state, open/reveal/create/settings callbacks.
- Produces: approved roomy project list and centered creation flow.

- [ ] **Step 1: Add project sorting tests before the helper**

Append to `tests/ui-state.test.ts` a test for `filterAndSortProjects(projects, query, sort)` asserting case-insensitive name filtering and descending `openedAt` sorting. Run `npm run test:ui`; expect FAIL because the helper is missing.

- [ ] **Step 2: Implement project filtering/sorting and Project Home**

Add the pure helper to `src/ui-state.ts`, then create `ProjectHome` with:

```ts
type ProjectHomeProps = {
  projects: RecentProject[];
  settings: AppSettings;
  hasProvider: boolean;
  creating: boolean;
  notice: string | null;
  onOpen: (project: RecentProject) => void;
  onReveal: (projectId: string) => void;
  onCreate: (name: string, customer: string, author: string) => void;
  onOpenSettings: () => void;
};
```

Render title/count, search, `recent|name` sort, one primary New Project button, roomy rows, status metadata, and an overflow menu containing only `在文件管理器中显示`. Render exact empty/configuration states from the spec.

- [ ] **Step 3: Implement the centered new-project dialog**

Use shared `Dialog size="short"`, `Field`, and `Button`. Validate trimmed name inline. Show customer and author as optional. Show the configured projects directory and a `更改` action that closes creation and opens General Settings. Disable submit while creating or while the directory is unavailable.

- [ ] **Step 4: Wire creation and reveal in App**

Keep the existing `createProjectFromForm` command path. After success, reload projects, close the dialog, and open the created project only if the registry returns it. Call `revealProject` for the row overflow action and surface failures through shared Notice state.

- [ ] **Step 5: Verify and remove the old landing page**

Run:

```bash
npm run test:ui
npm run lint
npm run build
```

Run native QA for projects present, no projects, no directory, stale directory, missing provider, search, sort, create cancel, validation, creation success, and reveal.

Delete `src/components/LandingPage.tsx` and confirm `rg -n "LandingPage|landing-shell|masthead" src` returns no matches.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/ui-state.ts tests/ui-state.test.ts src/components/app/ProjectHome.tsx src/components/app/NewProjectDialog.tsx src/components/LandingPage.tsx src/styles/shell.css
git commit -m "feat(ui): rebuild project home"
```

---

### Task 6: Consolidate General and Model Settings

**Files:**
- Create: `src/components/settings/SettingsDialog.tsx`
- Create: `src/components/settings/ProviderEditorDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/types.ts`
- Modify: `src/styles/dialogs.css`
- Delete after verification: `src/components/SettingsDialog.tsx`
- Delete after verification: `src/components/ProviderManager.tsx`

**Interfaces:**
- Consumes: existing project-directory and provider callbacks.
- Produces: one large Settings dialog with General and Models sections and a medium provider editor.

- [ ] **Step 1: Import the new settings component before creating it**

Change the App import to `./components/settings/SettingsDialog` and run `npm run lint`.

Expected: FAIL because the replacement module does not exist.

- [ ] **Step 2: Implement Settings General and Models navigation**

Create a large shared Dialog with internal `general|models` navigation. General shows the saved projects directory and Change/Clear actions. Models shows provider rows, default status, key-present status, Add, Edit, Set Default, and Delete. It does not render account, version, theme, or user UI.

- [ ] **Step 3: Implement provider add/edit with inline validation**

Move the existing provider form behavior into `ProviderEditorDialog`. Preserve blank-key-on-edit semantics. Replace `window.confirm` with shared confirmation Dialog state. Validation rules are: name required, URL required, model required, new provider key required, edited provider key optional.

- [ ] **Step 4: Wire existing provider actions and loading/errors**

Make App handlers await native completion before closing editor/resetting fields. Provider deletion must confirm, call `deleteProvider`, reload providers, and retain Settings on failure. Directory changes preserve UI settings through Task 1.

- [ ] **Step 5: Verify and remove legacy settings components**

Run `npm run lint` and `npm run build`. Native QA covers General/Models switching, focus trap, Escape, focus return, directory cancel/change/clear, add/edit/default/delete provider, blank edit key, error display, and narrow window sizing.

Delete the two root legacy components and confirm no imports remain.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/types.ts src/components/settings src/components/SettingsDialog.tsx src/components/ProviderManager.tsx src/styles/dialogs.css
git commit -m "feat(ui): unify application settings"
```

---

### Task 7: Rebuild the Central Conversation Workspace

**Files:**
- Create: `src/components/workspace/ProjectWorkspace.tsx`
- Create: `src/components/workspace/ConversationPane.tsx`
- Modify: `src/App.tsx`
- Modify: `src/types.ts`
- Modify: `src/styles/workspace.css`

**Interfaces:**
- Consumes: current project/node/session/run/message/composer state and existing callbacks.
- Produces: Codex-style workspace header and permanent central conversation.

- [ ] **Step 1: Import the nonexistent ProjectWorkspace and verify failure**

Replace the old Workbench import with `./components/workspace/ProjectWorkspace`. Run `npm run lint`; expect missing-module failure.

- [ ] **Step 2: Implement the workspace header**

The header renders a labeled back IconButton, project/node breadcrumb, node status, Materials action, session Popover, run Popover, and overflow actions. It does not render Save/Export buttons globally; those belong to Delivery.

- [ ] **Step 3: Implement the conversation pane**

Move existing sessions, messages, streaming transient message, preview-modification action, composer, send, and cancel callbacks into `ConversationPane`. Session rows live in a Popover with New Session. Run rows live in a separate Popover. Assistant output uses direct readable layout; user content uses a light neutral bubble.

Use this composer action rule:

```ts
const composerMode = activeRunId ? "stop" : sendingMessage ? "sending" : "send";
```

The send button is disabled only for empty text, pending send, or unavailable node. During a run it remains enabled as Stop and calls `onCancelAgent`.

- [ ] **Step 4: Wire App without changing native Agent behavior**

Remove `WorkbenchTab`, `workbenchTab`, and `isFileDrawerOpen`. Keep existing event listeners, `sendMessage`, cancellation, session creation, and message persistence. Replace notice text below the composer with shared Notice placement so saved-state chatter does not consume permanent space.

- [ ] **Step 5: Verify central conversation**

Run `npm run lint`, `npm run build`, `npm run test:ui`, and native QA: empty sessions, select/create session, send, queued run, streaming, stop, completed run refresh, failed run, modification preview trigger, keyboard focus, and compact width.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/types.ts src/components/workspace/ProjectWorkspace.tsx src/components/workspace/ConversationPane.tsx src/styles/workspace.css
git commit -m "feat(ui): rebuild conversation workspace"
```

---

### Task 8: Add Closable and Resizable Right Work Tabs

**Files:**
- Create: `src/components/workspace/WorkspaceTabs.tsx`
- Create: `src/components/workspace/DeliveryTab.tsx`
- Create: `src/components/workspace/ProjectFilesTab.tsx`
- Create: `src/components/workspace/FilePreviewTab.tsx`
- Create: `src/components/workspace/DeliveryPreviewTab.tsx`
- Create: `src/components/workspace/AgentRuleDialog.tsx`
- Modify: `src/components/workspace/ProjectWorkspace.tsx`
- Modify: `src/App.tsx`
- Modify: `tests/ui-state.test.ts`
- Modify: `src/styles/workspace.css`
- Delete after verification: `src/components/FilePreviewPane.tsx`
- Delete after verification: `src/components/Workbench.tsx`

**Interfaces:**
- Consumes: reducer tab IDs and existing node/file/delivery state.
- Produces: optional right pane, closable tabs, resizer, compact overlay, and existing edit/preview actions.

- [ ] **Step 1: Expand reducer tests for active-tab repair and width clamping**

Add tests asserting: closing an inactive tab preserves active; closing active selects the nearest remaining tab; `file:<id>` persists; `delivery-preview:*` does not; pane width clamps to 320 and 720. Run `npm run test:ui` and verify failures before updating reducer code.

- [ ] **Step 2: Implement WorkspaceTabs and pane resizing**

Render a shared `TabList` from `RightTabId[]`. Use pointer capture on a 6px separator; call `onPaneWidth(Math.round(width))` during drag. When the tab list is empty, render no pane. At compact width, render the pane as an overlay with an explicit close-pane action.

- [ ] **Step 3: Implement DeliveryTab**

Move the Markdown textarea, status, revision, character count, custom-rule entry, save, and export actions from old Workbench. One black primary action is allowed: Save when dirty, otherwise Export remains secondary. CAS conflict display is deferred to Task 9.

Move the existing custom-rule textarea into `AgentRuleDialog` using shared `Dialog size="large"`. Preserve additive-rule copy, save, clear, loading, and inline failure behavior.

- [ ] **Step 4: Implement file list and file preview tabs**

`ProjectFilesTab` owns import and context checkboxes. Clicking Preview opens `file:<fileId>` and loads bounded preview through the existing API. `FilePreviewTab` shows metadata, extracted text, truncation, unavailable, and failure states; it never renders a filesystem URL, iframe, or webview.

- [ ] **Step 5: Implement transient delivery preview tab**

When `previewAssistantDelivery` resolves, open `delivery-preview:<assistantMessageId>`. Render additions, deletions, unchanged, baseline revision, Markdown, Cancel, and Apply. Applying retains the existing CAS command and closes the transient tab only on success or conflict resolution.

- [ ] **Step 6: Verify and delete legacy workbench files**

Run `npm run test:ui`, `npm run lint`, and `npm run build`. Native QA covers every tab kind, final-tab close, reopen, file failure, transient-tab non-restoration, resize, compact overlay, edit/save/export, and delivery apply.

Delete old Workbench and FilePreviewPane after `rg -n "Workbench|FilePreviewPane|workbenchTab|isFileDrawerOpen" src` shows only intended new identifiers or no matches.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx tests/ui-state.test.ts src/components/workspace src/components/Workbench.tsx src/components/FilePreviewPane.tsx src/styles/workspace.css
git commit -m "feat(ui): add closable workspace tabs"
```

---

### Task 9: Add Dirty Navigation, Conflict Safety, and UI Persistence

**Files:**
- Create: `src/components/app/DirtyNavigationDialog.tsx`
- Create: `src/components/workspace/RevisionConflictDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/ui-state.ts`
- Modify: `tests/ui-state.test.ts`
- Modify: `src/styles/dialogs.css`

**Interfaces:**
- Consumes: dirty draft state, save command result, navigation intents, and `saveUiSettings`.
- Produces: one loss-safe navigation gate and debounced durable UI persistence.

- [ ] **Step 1: Add failing navigation-decision tests**

Add a `NavigationIntent` union and tests for queueing one of:

```ts
type NavigationIntent =
  | { kind: "destination"; destination: "projects" | "exports" }
  | { kind: "project"; projectId: string }
  | { kind: "node"; nodeId: NodeId }
  | { kind: "close-node"; nodeId: NodeId }
  | { kind: "close-window" };
```

Tests must assert clean intents execute immediately, dirty intents wait, Cancel clears the intent, Discard executes without saving, and Save executes only after a successful save result.

- [ ] **Step 2: Implement a single navigation gate in App**

Replace direct project/node/back/close calls with `requestNavigation(intent)`. Store one pending intent. Render `DirtyNavigationDialog` with exactly `保存并继续`, `放弃修改`, and `取消`. Save must await `saveNodeDraft()` returning `"saved" | "conflict" | "failed"`; only `saved` continues.

- [ ] **Step 3: Preserve the user draft on CAS conflict**

Change `saveNodeDraft` so `result.conflict` stores `conflict.latest` separately and does not replace `draft`. `RevisionConflictDialog` shows latest revision metadata and offers `继续编辑我的草稿` or `载入磁盘版本`; only the latter replaces the draft.

- [ ] **Step 4: Intercept native window close safely**

Use:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";

useEffect(() => {
  let unlisten: (() => void) | undefined;
  void getCurrentWindow().onCloseRequested((event) => {
    if (!dirty) return;
    event.preventDefault();
    requestNavigation({ kind: "close-window" });
  }).then((stop) => { unlisten = stop; });
  return () => unlisten?.();
}, [dirty]);
```

After the user resolves the intent, call `getCurrentWindow().destroy()` only for the confirmed close-window path.

- [ ] **Step 5: Persist durable UI settings with debounce**

After settings load, debounce `saveUiSettings(durableUiSettings(ui))` by 300ms. Skip the first effect until hydration completes. Do not persist transient delivery previews. On failure, keep local UI state and show one dismissible warning rather than retrying in a tight loop.

- [ ] **Step 6: Run all focused verification**

Run `npm run test:ui`, `npm run lint`, `npm run build`, and native QA for back, project switch, node switch, active/inactive node close, final node close, window close, save success, save failure, discard, cancel, CAS conflict, restart restoration, intentionally empty tabs, and intentionally empty opened-node list.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/ui-state.ts tests/ui-state.test.ts src/components/app/DirtyNavigationDialog.tsx src/components/workspace/RevisionConflictDialog.tsx src/styles/dialogs.css
git commit -m "feat(ui): guard dirty workspace navigation"
```

---

### Task 10: Build Export Center and Complete Shell Destinations

**Files:**
- Create: `src/components/app/ExportCenter.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/app/AppShell.tsx`
- Modify: `src/styles/shell.css`

**Interfaces:**
- Consumes: existing `exportDocx`, projects, active export state, output path, and shared notifications.
- Produces: Projects/Exports destination switching without fake formats or history.

- [ ] **Step 1: Import ExportCenter before creating it and verify failure**

Add the App import and route the `exports` destination to it. Run `npm run lint`; expect missing-module failure.

- [ ] **Step 2: Implement the existing DOCX flow as a focused page**

`ExportCenter` accepts projects, selected project ID, exporting state, last result, select callback, and export callback. Render one project select, one DOCX format row, one Export primary button, and current in-progress/success/failure/output-path state. Do not render history, cloud, schedules, or unsupported formats.

Refactor the App handler to `async function exportDocx(projectId: string)`. `DeliveryTab` passes the active project ID; Export Center passes its selected project ID. Exporting from the center must not set the active workspace project or load a node.

- [ ] **Step 3: Wire shell destination persistence**

Selecting Projects/Exports updates `ui.lastDestination`. Opening a project switches to `workspace` without persisting that as a global destination; returning uses Projects. A restart restores Projects or Exports only.

- [ ] **Step 4: Verify destination and export behavior**

Run `npm run lint`, `npm run build`, and native QA: project selection, cancel native save dialog, successful export path, export error, switching destinations, sidebar active state, and restart restoration.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/app/AppShell.tsx src/components/app/ExportCenter.tsx src/styles/shell.css
git commit -m "feat(ui): add DOCX export center"
```

---

### Task 11: Accessibility, Compact Layout, Cleanup, and Full Verification

**Files:**
- Modify: `src/styles/responsive.css`
- Modify: `src/styles/primitives.css`
- Modify: `src/styles/shell.css`
- Modify: `src/styles/workspace.css`
- Modify: `src/styles/dialogs.css`
- Modify: `src/App.tsx`
- Modify: `README.md`
- Modify: `README.en.md`
- Delete: any remaining superseded root-level UI components

**Interfaces:**
- Consumes: all completed screens and shared primitives.
- Produces: final accessible desktop UI and documented behavior.

- [ ] **Step 1: Add the final responsive rules**

At normal widths, keep sidebar + conversation + right pane. At `max-width: 1080px`, make the right pane a fixed overlay. At `max-width: 960px`, allow sidebar collapse and keep the main pane at `min-width: 0`; do not set a global body `min-width` that causes horizontal clipping. Dialogs use `max-width: calc(100vw - 32px)` and `max-height: calc(100vh - 32px)`.

- [ ] **Step 2: Perform the keyboard/accessibility pass**

Verify every IconButton has an accessible label, every field has a label, status includes text, tab/tabpanel IDs match, dialogs focus/restore correctly, popovers close safely, and all interactive elements have visible `:focus-visible`. Fix any violations before proceeding.

- [ ] **Step 3: Remove legacy visual/state code**

Remove `AppVersion` loading and footer use because version is no longer visible. Remove `WorkbenchTab`, legacy CSS selectors, `window.confirm`, obsolete provider/landing/workbench props, and dead imports. Run:

```bash
rg -n "font-reading|landing-shell|workbench-shell|window\.confirm|WorkbenchTab|appVersion" src
```

Expected: no matches, except an intentionally retained backend `app_get_version` API wrapper if another documented caller still needs it.

- [ ] **Step 4: Update product documentation**

Update README feature/UI descriptions to state: persistent project shell, project hub, opened nodes, central conversation, right delivery/files tabs, Settings-contained model configuration, and existing local-only/native boundaries. Do not document unimplemented cloud, browser, account, or export features.

- [ ] **Step 5: Run full automated verification**

Run:

```bash
npm run test:ui
npm run lint
npm run build
npm run test:no-browser-runtime
npm run test:no-legacy-migration-runtime
npm run test:rust
cargo test --workspace
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo clippy --workspace -- -D warnings
```

Expected: every command exits 0 with no TypeScript, Rust, Clippy, or boundary-check failures.

- [ ] **Step 6: Run the native visual acceptance matrix**

Start `npm run tauri dev` and verify at wide, normal, and approximately 960px widths:

- project hub, search, sort, empty, missing directory, and missing model;
- all-project sidebar scroll, collapse, active project, opened nodes, final-node close, and node picker;
- central conversation, sessions, run popover, streaming, stop, and messages;
- delivery/files/file-preview/delivery-preview tabs, final-tab close, resize, and compact overlay;
- Settings General/Models, new project, provider editor, delete confirm, dirty confirm, conflict, and custom-rule dialogs;
- Export Center success/cancel/failure;
- keyboard-only navigation, Escape, focus restoration, and Cmd/Ctrl+S;
- application restart restoring durable UI state while omitting transient preview tabs.

Record any visual defects, fix them in the owning focused component/CSS file, and rerun the affected automated command.

- [ ] **Step 7: Commit**

```bash
git add src README.md README.en.md package.json
git commit -m "feat(ui): complete Codex-style Sion redesign"
```

---

## Requirement Coverage

| Approved requirement | Task |
|---|---|
| Persistent Codex-style light shell | Tasks 3–4 |
| Project hub with roomy list | Task 5 |
| Centered creation dialog | Task 5 |
| All projects in scrollable sidebar | Task 4 |
| Settings only at bottom-left | Tasks 4 and 6 |
| No user/version/dark theme | Tasks 3, 4, 6, and 11 |
| Opened nodes only, with close | Tasks 2, 4, and 9 |
| Save/discard/cancel dirty protection | Task 9 |
| Visible back button | Tasks 7 and 9 |
| Central conversation | Task 7 |
| Closable right work tabs | Task 8 |
| Resizable/overlay right pane | Tasks 8 and 11 |
| Unified settings/model UI | Task 6 |
| Existing DOCX export center | Task 10 |
| Reusable controls and visual standard | Task 3 |
| Sidebar project/node search | Task 4 |
| Unified success/warning/error notifications | Tasks 3, 4, and 11 |
| UI state persistence | Tasks 1, 2, and 9 |
| Existing native/domain behavior preserved | Tasks 7–11 verification |
