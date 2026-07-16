# Sion Codex-Style UI Redesign

**Date:** 2026-07-16

**Status:** Design approved in conversation; awaiting written-spec review

## Problem

Sion's current desktop UI exposes the product's capabilities but does not present them as one coherent application. The landing page and workbench use different visual hierarchies, the workbench permanently compresses three dense columns, the Sion wordmark acts as an unlabeled exit control, and the fixed `chat`/`draft` switch cannot express closable work surfaces. Buttons, dialogs, fields, status colors, and empty states are styled locally rather than governed by a reusable standard.

The redesign must make the entire application feel like the Codex desktop reference supplied during design review: a quiet, light, desktop-native shell with stable navigation, a focused conversation workspace, and an optional review pane. It must also correct the concrete interaction gaps: a visible back action, closable opened nodes, closable right-side tabs, and consistent controls across the home page, workbench, settings, provider management, export, and dialogs.

## Goals

- Replace the current landing/workbench split with one persistent, Codex-style application shell.
- Redesign the entire frontend UI layer rather than applying a CSS-only reskin.
- Make the project home a restrained project hub with a searchable, roomy list.
- Make the project workspace a central conversation plus optional right-side work tabs.
- Add explicit back navigation and safe close behavior for opened nodes and tabs.
- Establish enforceable design tokens and reusable primitives for buttons, fields, tabs, dialogs, notifications, and states.
- Preserve existing project, node, session, file, Agent, delivery, and DOCX behavior behind the existing Tauri boundary.
- Persist presentation state such as opened nodes, active node, sidebar state, durable right tabs, and pane width as global UI settings rather than project content.

## Non-goals

- A dark theme.
- Accounts, avatars, login, user profiles, or a version label in the sidebar.
- New export formats, cloud export, cloud synchronization, or fabricated export history.
- Rewriting Rust domain behavior, storage formats, Agent scheduling, delivery validation, or file extraction.
- Adding browser search, browser automation, Playwright, or web egress to the desktop runtime.
- Introducing a frontend router solely for this redesign.
- Turning the home page into an analytics dashboard or card-heavy management console.

## Chosen Direction

The chosen approach is a full UI-layer reconstruction around a shared shell and component system. Existing Tauri commands and business state remain authoritative. `App.tsx` continues to coordinate application data and native calls, while focused components render the shell, home, project workspace, work surfaces, settings, and dialogs.

Two alternatives were rejected:

1. A JSX/CSS-only reskin would leave the current component boundaries and one-off control styles intact.
2. A complete frontend and state-management rewrite would add unnecessary behavioral risk to already working project and Agent flows.

## Information Architecture

### Persistent application shell

The application always renders the same shell. Switching between the project hub, export center, and a project changes the main content without replacing the navigation frame.

The sidebar contains:

- the Sion wordmark and search action;
- `项目` and `导出中心` as the only top-level destinations;
- a scrollable list of every project;
- only the opened workflow nodes beneath the expanded current project;
- an `全部节点` action for accessing all 12 nodes; and
- `设置` as the only bottom action.

There is no permanent `新建项目` sidebar action. Project creation starts from the project hub. Model configuration lives inside Settings rather than as top-level navigation.

The sidebar can collapse. Its collapsed state is restored after restart. When expanded, all projects remain available through local scrolling rather than being limited to a recent subset.

### Project hub

The default home view is a project hub, not a creation form. It contains:

- the page title and project count;
- a project search field;
- a recent/name sorting control;
- a single `新建项目` primary button; and
- a roomy row list rather than cards.

Each project row shows the project name, current or last active node, concise activity/state, last-opened time, and an overflow menu. Clicking the row opens the project. The overflow menu contains `在文件管理器中显示`; it does not expose project deletion.

The empty state presents one explanation and one creation action. If the project container is unavailable, the state explains the problem and leads directly to its setting. A missing model configuration does not block local editing; it is surfaced as a quiet notice and becomes blocking only when an Agent run is requested.

### Project creation

`新建项目` opens a centered short-form dialog. Project name is required; customer and author are optional. The dialog displays the current project container and links to the setting used to change it. Creation uses the existing native command and does not expose filesystem access to React.

## Project Workspace

The workspace follows the supplied Codex layout: stable project navigation on the left, conversation in the center, and optional work tabs on the right.

### Header and navigation

The center header contains:

- a clearly labeled back icon that returns to the project hub;
- project and node breadcrumbs;
- the node's save/status indicator;
- a project-materials action; and
- a restrained overflow menu.

The Sion wordmark no longer doubles as an implicit back button.

The current project is expanded in the sidebar. Only opened nodes are listed beneath it. `全部节点` opens a searchable node selector with node status. Selecting a node opens it if needed and makes it active. Hovering an opened node reveals its close action. Closing a node removes only the presentation entry; it never deletes node content.

Closing the active node activates the most recently used remaining opened node. Closing the final opened node leaves the project selected and replaces the center with a focused `选择节点` empty state. It does not silently reopen a node or return to the project hub. The first time a project is opened without any saved UI state, `项目基本信息` is opened as the initial node.

### Central conversation

Conversation is the permanent central surface rather than one side of a `chat`/`draft` toggle.

- The session selector moves into the header as a menu, together with `新建会话`.
- Agent run history/status moves into a header popover instead of occupying permanent vertical space.
- User messages use restrained light-gray bubbles; assistant messages use direct, readable document layout.
- The composer remains fixed at the bottom and groups attachments, selected context, send, and cancel-run controls in one toolbar.
- During a run, the send action becomes a stop action while existing SSE streaming and cancellation behavior remain unchanged.

### Right work tabs

The right pane hosts closable tabs. Supported tab kinds are:

- `交付稿`;
- `资料`;
- a bounded preview for an individual project file; and
- a transient assistant-delivery modification preview.

The final right tab can be closed. When no right tabs remain, the pane disappears and the conversation expands. Reopening a supported surface restores the pane. The pane is resizable; its width is stored as UI state. At compact desktop widths it overlays the conversation rather than compressing all columns below usable sizes.

The delivery tab owns Markdown editing, node revision, character count, save status, save action, export entry, and custom Agent-rule entry. File tabs own file context selection and bounded extracted-text display. Modification-preview tabs own additions, deletions, unchanged count, baseline revision, cancel, and apply actions.

On a project's first open without saved UI state, `交付稿` is the initial right tab. After that initialization, durable tab identities such as delivery, materials, and a valid file ID are restored exactly, including an intentionally empty tab list. Transient delivery previews are never restored because their preview payload is not durable application state.

## Settings, Export, and Dialogs

### Settings

Settings is a large centered dialog with two internal sections:

- `通用`: project-container directory and other existing application-level preferences.
- `模型`: provider list, default provider/model, and add/edit/delete actions.

API keys remain masked in the UI and follow the repository's existing credential-storage boundary. Settings contains no user, account, version, or theme section.

### Export center

Export Center is a main-shell destination backed only by the existing DOCX export capability. It allows project selection, starts native export, and reports in-progress, success, output path, or failure. It does not claim unsupported formats or persistent export history.

### Dialog hierarchy

All modal surfaces use shared primitives:

- short-form dialog, 480 px at normal window widths, for project creation;
- medium form dialog, 640 px at normal window widths, for provider creation and editing;
- confirmation dialog, smaller and concise, for dirty-node close and destructive actions;
- large dialog, 800 px at normal window widths, for Settings and provider management; and
- large editor dialog for node-specific custom rules.

Dialogs share a title/description header, close action, content region, footer actions, focus trap, `Escape` handling, initial focus, return-focus behavior, validation placement, loading behavior, and error presentation.

File preview and assistant modification preview are work tabs, not modal overlays.

## Visual System

The UI is light-only and deliberately quiet.

### Color and elevation

- Sidebar: very light neutral gray.
- Main content: white.
- Secondary or inset surfaces: a second neutral gray.
- Borders: subtle neutral gray, used instead of heavy cards or shadows.
- Primary action: near-black.
- Success/saved: green.
- Dirty/warning: orange.
- Destructive/error: red.

Accent colors never decorate large areas. Gradients, ornamental color blocks, and heavy shadows are not used. Shadows are reserved for transient floating surfaces.

### Typography and spacing

The entire interface uses a modern system sans-serif stack. The current editorial serif treatment is removed from headings, messages, and the Markdown editor.

- ordinary UI/body text: 14 px;
- helper text and metadata: 12 px;
- page titles: 20–24 px;
- spacing scale based on 4 px, principally 8, 12, 16, 24, and 32 px;
- radii limited to 6, 8, and 12 px.

### Control standards

Buttons have four variants: primary, secondary, ghost, and destructive. A surface contains at most one primary action. Icon buttons use a 28–32 px hit area and always have an accessible label.

Fields, search inputs, selects, and text areas share heights, borders, focus rings, disabled appearance, validation text, and loading behavior.

Tabs share active, hover, close, dirty, focus, and keyboard states. A close icon is hidden by default and appears on hover or when the tab/item is active.

Loading, empty, error, success, running, disabled, and conflict states use shared components rather than local color and copy decisions.

## Component Boundaries

The intended frontend responsibilities are:

| Unit | Responsibility |
|---|---|
| `AppShell` | Persistent sidebar, main destination, global dialogs, and notification viewport. |
| `Sidebar` | Top-level destinations, all-project scrolling, opened nodes, collapse state, and Settings entry. |
| `ProjectHome` | Searchable/sortable project hub, empty states, and project creation entry. |
| `ProjectWorkspace` | Header, central conversation, resizable optional work pane, and dirty-navigation guards. |
| `ConversationPane` | Session selection, run status, messages, composer, streaming, and cancellation controls. |
| `WorkspaceTabs` | Right-pane tab lifecycle, close behavior, active tab, and compact-window overlay. |
| `DeliveryTab` | Markdown draft, revision metadata, save, export, and custom-rule entry. |
| `ProjectFilesTab` | File list, Agent-context selection, and preview-open actions. |
| `FilePreviewTab` | Bounded extracted-text preview and failure/truncation states. |
| `DeliveryPreviewTab` | Delivery statistics, full preview, cancel, and apply. |
| `SettingsDialog` | General and model sections. |
| UI primitives | Button, IconButton, Field, Select, Tabs, Dialog, Menu, Popover, Notice, EmptyState, Spinner, and StatusDot. |

`App.tsx` remains the coordinator for native commands and domain state. UI components do not invoke Tauri directly unless they are a deliberately isolated command boundary with a typed interface. No React component reads local files or contacts model providers.

## UI State and Persistence

Global presentation settings include:

- sidebar collapsed state;
- for each known project, opened node IDs and the last active node ID;
- durable right-tab identities and active tab;
- initialization flags that distinguish first-open defaults from intentionally empty node/tab lists;
- right-pane width; and
- last main-shell destination.

This state contains identifiers and presentation preferences only. It contains no node Markdown, chat content, extracted file text, API key, or delivery preview payload. It is stored through the native application-settings boundary, not in project content and not through browser-local storage.

When persisted identifiers no longer resolve, the UI drops them safely and falls back to the project's basic-information node and default delivery tab.

## Dirty-State and Error Handling

Back navigation, project switching, opened-node close, and application close all consult one dirty-navigation guard. When the current node has unsaved edits, the user may:

- save and continue;
- discard and continue; or
- cancel navigation.

Saving retains existing CAS revision validation. A CAS conflict keeps the user's draft intact and opens a conflict-specific surface; the UI never silently overwrites a newer disk revision.

Form errors appear below their fields. Native failures appear as inline page errors or shared notifications rather than browser alerts. A failed refresh retains the last successful content when safe and offers retry. File-preview failure remains local to its tab and does not block conversation or editing.

Non-critical success notifications dismiss after four seconds. Save state remains visible inline rather than appearing as repeated toasts. Warnings involving data and all errors require explicit dismissal or resolution.

## Accessibility and Compact Windows

- All controls have visible keyboard focus.
- Sidebar items, menus, tabs, and dialogs have appropriate roles and labels.
- Tabs support arrow-key traversal. Closing uses the visible, keyboard-focusable close action; the redesign does not overload the platform window-close shortcut.
- Dialogs trap focus, close with `Escape` when safe, and restore focus to their trigger.
- Status is never communicated by color alone.
- The sidebar can collapse; the right pane becomes an overlay at compact widths.
- The application remains usable at approximately 960 px without horizontal page clipping.

## Verification

Automated verification includes:

```bash
npm run lint
npm run build
npm run test:rust
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

The redesign must preserve static enforcement that React does not access the local filesystem or model network. UI state transitions with meaningful data-loss risk—dirty navigation, tab close, persistence sanitization, and fallback selection—must be isolated into pure logic and covered by focused tests without introducing a large test framework solely for visual styling.

Native desktop visual QA covers:

- project hub, empty state, unavailable container, and missing-model notice;
- project workspace at wide, normal, and approximately 960 px widths;
- sidebar collapse, all-project scrolling, opened-node close, and node selector;
- right-tab open/close, resize, restoration, and compact overlay;
- settings, provider forms, project creation, export center, custom rules, and confirmation dialogs;
- keyboard-only navigation, focus restoration, `Escape`, and save shortcut;
- loading, Agent failure, file-preview failure, CAS conflict, and dirty-close flows.

## Acceptance Criteria

- Home and project views share one Codex-style light shell.
- A visible back button returns from a project to the project hub.
- Opened nodes and right work tabs can be closed without deleting their underlying data.
- Dirty navigation always offers save, discard, and cancel.
- The bottom-left sidebar contains Settings only.
- There is no account/user UI, version label, or dark theme.
- Project home uses the approved roomy list rather than cards.
- New project uses the approved centered dialog.
- Conversation remains visible while delivery or file work is open in the right pane.
- Buttons, fields, tabs, dialogs, notifications, and states use shared primitives and design tokens.
- Existing local project, Agent, file, delivery, and DOCX export behavior remains intact.
