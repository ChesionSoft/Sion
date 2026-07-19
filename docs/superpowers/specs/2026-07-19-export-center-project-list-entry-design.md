# Export Center Project-List Entry

**Date:** 2026-07-19  
**Status:** Approved for planning  
**Branch context:** `feat/export-center-redesign`

## Problem

Export Center currently lands users in a workbench with a project dropdown and auto-resolves a project via `resolveExportProjectId` (remembered export selection, then workbench active, then most recent). That skips an explicit “pick a project” step and feels unlike Project Home.

Users want Export Center to work like opening a project: **enter → project list → choose one → export workbench**.

## Goals

1. Sidebar “导出” always shows a project list first.
2. Selecting a project opens that project’s export workbench.
3. Switching projects requires returning to the list (no in-workbench project dropdown).
4. List UI aligns with Project Home (name, recent open time, search/sort)—not export status badges.
5. Export project selection stays independent of the workbench’s open project.

## Non-goals

- Export progress / blueprint-draft-docx badges on list rows.
- Changing `MainDestination` (no `export-workspace` destination).
- Writing export selection back into workbench active project.
- Creating projects from Export Center.
- Persisting “last export workbench” across re-entry or app restart (re-entry always list).
- Blocking leave while an export run is in progress (runs continue by project id).

## Decisions (from brainstorming)

| Topic | Choice |
|-------|--------|
| Re-enter 导出 | **Always list first** |
| Switch project | **Back to list only** |
| List content | **Align with Project Home** |
| Architecture | **Two screens inside Export Center** (not dual destinations, not shared ProjectHome mode) |

## Design

### Navigation state

Owned primarily by `App`:

- `exportProjectId: string | null`
  - `null` → list screen
  - non-null → workbench for that project
- On every sidebar navigation to `"exports"` (including when already on exports), set `exportProjectId` to `null` so the user always lands on the list. Implement by clearing in the destination handler, not only on `destination` transitions.
- Remove the effect that auto-fills `exportProjectId` via `resolveExportProjectId` on entering exports.
- `exportRefreshByProject` remains keyed by project id; list screen does not load workspace snapshots.

Optional local UI state inside list (search query, sort) need not persist.

### Screen A — Export project list

New presentational component (e.g. `ExportProjectList`):

- Header: title “导出”, subtitle “选择要导出的项目”, project count.
- Toolbar: name search + sort (`recent` | `name`) via existing `filterAndSortProjects`.
- Rows: same visual language as Project Home (`project-list` / row layout)—icon, name, last opened time.
- Primary click: `onOpenProject(projectId)`.
- Row menu: **打开导出文件夹** (reuse `revealExportFolder`). Optional “在文件管理器中显示项目” is out of minimum scope.
- Empty states:
  - No projects → guide user to 项目 page (no create-project CTA that opens NewProjectDialog here).
  - Search miss → clear search.
  - No projects directory → open settings (same as Project Home).

No new IPC for listing; uses existing `projects: RecentProject[]`.

### Screen B — Export workbench

Existing Export Center workbench content (blueprint bar, navigator, preview, action bar, run banners) when `exportProjectId` is set.

Header changes:

| Element | Change |
|---------|--------|
| Project `SelectField` | **Remove** |
| Back control | **Add** “← 所有导出项目” (or equivalent) → `onBackToList()` |
| Project identity | Read-only name next to title |
| Primary pipeline button, cancel, run status | Keep |
| 打开导出文件夹 | Keep |

`ExportCenter` structure:

```
ExportCenter
├─ projectId == null → ExportProjectList
└─ projectId != null → workbench
```

Props direction:

- `projectId: string | null` (explicit; drop active/remembered triangle for entry)
- `projects`, `providers`, `refreshToken`, `onNotice`
- `onOpenProject(projectId: string)`, `onBackToList()`
- Settings/projectsDirectory only if list needs empty-state for unset directory (pass through from App)

### `resolveExportProjectId`

Stop using it for “enter exports → auto pick”. After this change:

- Either delete if unused, or keep only if another caller remains (none expected).
- Regression tests that required auto-resolve on entry should assert list-first behavior instead.

### Error handling

- Workbench load failure or project removed from discovery: notice + return to list (`onBackToList`).
- Reveal export folder failures: existing notice path.
- Leaving workbench during an active export run is allowed; events still scope by `projectId` when user re-opens that project.

### Data flow

```text
Sidebar → destination=exports, exportProjectId=null
       → ExportProjectList
       → user selects project
       → setExportProjectId(id)
       → workbench getExportWorkspace(id)
       → back
       → setExportProjectId(null)
```

No change to export CAS, model runs, or artifact APIs.

## Testing

1. Enter 导出 → list visible; workbench not auto-opened even if workbench has an active project or prior `exportProjectId`.
2. Open project from list → workbench for that id; snapshot loads.
3. Back → list; workbench unmounted / no stale primary actions for previous project.
4. Click 导出 again while mid-workbench → list (`exportProjectId` cleared in destination handler).
5. Empty / search-empty states.
6. Workbench has no project dropdown; has back + 打开导出文件夹.
7. Source regressions updated for new entry model.

## Implementation notes (for planning)

- Touch: `App.tsx`, `ExportCenter.tsx`, new list component, `export.css` / reuse project-home styles, `export-state.ts`, `api.ts` already has `revealExportFolder`, tests under `tests/workspace-regressions.test.ts`.
- Prefer reusing CSS classes from project list over a full visual redesign.
- Keep changes UI-local; no Rust changes required unless reveal path needs adjustment (already present).

## Success criteria

- User never lands in a full export workbench without explicitly choosing a project from the export list in that visit.
- Switching projects is list-mediated only.
- List feels familiar to Project Home without inventing export-status chrome.
