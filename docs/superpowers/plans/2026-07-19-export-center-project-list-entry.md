# Export Center Project-List Entry Implementation Plan

> **For agentic workers:** Inline execution in the implementing session. Steps use checkbox syntax for tracking.

**Goal:** Export Center always opens a Project Home–style project list; choosing a project enters the export workbench; switching projects requires returning to the list.

**Architecture:** `App` owns `exportProjectId` (`null` = list). Sidebar navigation to `exports` always clears it. `ExportCenter` renders `ExportProjectList` or the existing workbench. No new IPC.

**Tech Stack:** React 19, existing `filterAndSortProjects`, project-list CSS classes, `revealExportFolder`.

## Global Constraints

- Always list-first on 导出 entry (including re-click while mid-workbench).
- No project dropdown in workbench; back control only.
- Export selection independent of workbench active project.
- No export status badges on list rows.
- No Rust changes required.

---

### Task 1: ExportProjectList + ExportCenter two-screen

**Files:**
- Create: `src/components/export/ExportProjectList.tsx`
- Modify: `src/components/app/ExportCenter.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/export.css` (minimal if needed)
- Modify: `tests/workspace-regressions.test.ts`

**Interfaces:**
- `ExportCenterProps`: `projectId: string | null`, `projects`, `projectsDirectory`, `providers`, `refreshToken`, `onOpenProject`, `onBackToList`, `onOpenSettings`, `onGoToProjects`, `onNotice`
- List: `onOpenProject`, `onRevealExportFolder`, `onOpenSettings`, `onGoToProjects`

- [x] Implement list component (search/sort/rows/empty states)
- [x] ExportCenter: list when `!projectId`, workbench when set; remove SelectField; add back + project name
- [x] App: clear `exportProjectId` on every 导出 destination; remove auto-resolve effect; wire new props
- [x] Update regressions; lint

---
