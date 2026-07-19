import assert from "node:assert/strict";
import test from "node:test";

import {
  exportArtifactGroups,
  resolveDefaultExportModelSelection,
  resolveExportProjectId,
} from "../src/export-state.ts";
import type {
  ExportArtifactKind,
  ExportArtifactSummary,
  Provider,
  RecentProject,
} from "../src/types.ts";

const projects = (): RecentProject[] => [
  { id: "old", name: "Old", rootPath: "/old", openedAt: "2026-07-18T00:00:00Z" },
  { id: "new", name: "New", rootPath: "/new", openedAt: "2026-07-19T00:00:00Z" },
];

const providers = (): Provider[] => [
  {
    id: "provider-1",
    name: "Provider One",
    apiBaseUrl: "https://a.example",
    apiUrlMode: "base",
    protocol: "chat_completions",
    isDefault: true,
    hasApiKey: true,
    models: [
      { name: "model-1", isDefault: true, toolCalling: false, contextWindowTokens: null },
      { name: "model-2", isDefault: false, toolCalling: false, contextWindowTokens: null },
    ],
  },
  {
    id: "provider-2",
    name: "Provider Two",
    apiBaseUrl: "https://b.example",
    apiUrlMode: "base",
    protocol: "chat_completions",
    isDefault: false,
    hasApiKey: true,
    models: [
      { name: "model-other", isDefault: true, toolCalling: false, contextWindowTokens: null },
    ],
  },
];

const artifact = (kind: ExportArtifactKind): ExportArtifactSummary => ({
  kind,
  filename: "file.md",
  revision: 1,
  digest: "digest",
  available: true,
  updatedAt: "2026-07-19T00:00:00Z",
  stale: false,
  byteSize: 0,
});

test("defaults export project to remembered then active then most recent", () => {
  // Explicit export selection wins over workbench active project
  assert.equal(resolveExportProjectId(projects(), "old", "new"), "new");
  assert.equal(resolveExportProjectId(projects(), "old", "old"), "old");
  // No memory → active
  assert.equal(resolveExportProjectId(projects(), "old", null), "old");
  // No memory, no active → most recent openedAt
  assert.equal(resolveExportProjectId(projects(), null, null), "new");
  // Stale memory falls back to active
  assert.equal(resolveExportProjectId(projects(), "old", "missing"), "old");
});

test("default model selection uses the default provider and model", () => {
  assert.deepEqual(resolveDefaultExportModelSelection(providers()), {
    providerId: "provider-1",
    model: "model-1",
    reasoningEffort: "medium",
  });
});

test("default model selection is null when no provider has a model", () => {
  const empty: Provider[] = [
    {
      id: "provider-1",
      name: "Provider One",
      apiBaseUrl: "https://a.example",
      apiUrlMode: "base",
      protocol: "chat_completions",
      isDefault: true,
      hasApiKey: true,
      models: [],
    },
  ];
  assert.equal(resolveDefaultExportModelSelection(empty), null);
});

test("artifact groups exclude blueprint and include seven artifacts", () => {
  const groups = exportArtifactGroups([
    artifact("formal_draft"),
    artifact("formal_docx"),
    artifact("project_design"),
    artifact("spec"),
    artifact("tasks"),
    artifact("agents"),
    artifact("qa_report"),
    artifact("blueprint"),
  ]);
  assert.equal(groups.flatMap((group) => group.items).length, 7);
  assert.equal(
    groups
      .flatMap((group) => group.items)
      .some((item) => item.kind === "blueprint"),
    false,
  );
});