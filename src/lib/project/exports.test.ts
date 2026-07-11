import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveBlueprintArtifact,
  approveDraftArtifact,
  canFinalize,
  exportProjectDocuments,
  readStageState,
  writeBlueprintArtifact,
  writeDraftArtifact,
} from "./exports";
import type { FormalPrdBlueprint } from "./formal-prd";
import { ProjectStore } from "./store";

let rootDir: string;
let store: ProjectStore;
let projectId: string;

const blueprint: FormalPrdBlueprint = {
  title: "正式 PRD 导出蓝图",
  sections: [
    {
      id: "executive-summary",
      title: "执行摘要",
      inclusion: "confirmed-summary",
      presentation: "paragraphs",
      sourceNodeIds: ["goals"],
      sourceHeadings: ["总体目标"],
      rationale: "向外部说明已确认的建设目标",
    },
  ],
};

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "Sion-export-"));
  store = new ProjectStore(rootDir);
  const project = await store.createProject({
    name: "库存管理系统",
    customerName: "示例客户",
    authorName: "示例团队",
    now: "2026-06-14T10:00:00.000Z",
  });
  projectId = project.id;
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("canFinalize", () => {
  it("is false when nothing is approved", () => {
    expect(canFinalize({ updatedAt: "" })).toBe(false);
  });

  it("is false when only the blueprint is approved", () => {
    expect(canFinalize({ blueprintDigest: "d1", blueprintApprovedDigest: "d1", updatedAt: "" })).toBe(false);
  });

  it("is false on digest mismatch", () => {
    expect(
      canFinalize({
        blueprintDigest: "d1",
        blueprintApprovedDigest: "x",
        draftDigest: "d2",
        draftApprovedDigest: "d2",
        updatedAt: "",
      }),
    ).toBe(false);
  });

  it("is true when both approved digests match the current digests", () => {
    expect(
      canFinalize({
        blueprintDigest: "d1",
        blueprintApprovedDigest: "d1",
        draftDigest: "d2",
        draftApprovedDigest: "d2",
        updatedAt: "",
      }),
    ).toBe(true);
  });
});

describe("staged artifacts", () => {
  it("writeBlueprintArtifact serializes the blueprint and records its digest", async () => {
    const state = await writeBlueprintArtifact(store, projectId, blueprint);
    expect(state.blueprintDigest).toBeTruthy();
    expect(state.blueprint).toEqual(blueprint);
    expect(state.blueprintApprovedDigest).toBeUndefined();
    const md = await readFile(path.join(rootDir, projectId, "exports", "export-blueprint.md"), "utf8");
    expect(md).toContain("导出蓝图");
    expect(md).toContain("执行摘要");
  });

  it("approveBlueprintArtifact accepts a matching digest and rejects a stale one", async () => {
    const state = await writeBlueprintArtifact(store, projectId, blueprint);
    const approved = await approveBlueprintArtifact(store, projectId, state.blueprintDigest!);
    expect(approved.blueprintApprovedDigest).toBe(state.blueprintDigest);
    await expect(approveBlueprintArtifact(store, projectId, "stale")).rejects.toThrow();
  });

  it("writeDraftArtifact refuses before the blueprint is approved", async () => {
    await expect(writeDraftArtifact(store, projectId, "## 执行摘要\n\n已确认正文。")).rejects.toThrow();
  });

  it("writeDraftArtifact writes the formal draft after blueprint approval", async () => {
    const bp = await writeBlueprintArtifact(store, projectId, blueprint);
    await approveBlueprintArtifact(store, projectId, bp.blueprintDigest!);
    const state = await writeDraftArtifact(store, projectId, "## 执行摘要\n\n已确认正文。");
    expect(state.draftDigest).toBeTruthy();
    const md = await readFile(path.join(rootDir, projectId, "exports", "formal-prd-draft.md"), "utf8");
    expect(md).toContain("已确认正文");
  });

  it("writeDraftArtifact rejects forbidden process noise", async () => {
    const bp = await writeBlueprintArtifact(store, projectId, blueprint);
    await approveBlueprintArtifact(store, projectId, bp.blueprintDigest!);
    await expect(writeDraftArtifact(store, projectId, "## 执行摘要\n\n待确认：补充内容。")).rejects.toThrow();
  });

  it("full approval flow enables finalization", async () => {
    const bp = await writeBlueprintArtifact(store, projectId, blueprint);
    await approveBlueprintArtifact(store, projectId, bp.blueprintDigest!);
    const draft = await writeDraftArtifact(store, projectId, "## 执行摘要\n\n已确认正文。");
    await approveDraftArtifact(store, projectId, draft.draftDigest!);
    const state = await readStageState(store, projectId);
    expect(canFinalize(state)).toBe(true);
  });
});

describe("exportProjectDocuments (internal exports)", () => {
  it("writes the four internal markdown exports and no docx", async () => {
    const result = await exportProjectDocuments(store, projectId);
    expect(result.files.map((file) => file.filename)).toEqual([
      "PROJECT_DESIGN.md",
      "SPEC.md",
      "TASKS.md",
      "AGENTS.md",
    ]);
    const md = await readFile(path.join(rootDir, projectId, "exports", "PROJECT_DESIGN.md"), "utf8");
    expect(md).toContain("项目开发设计文档");
  });

  it("uses a provided master for PROJECT_DESIGN.md", async () => {
    await store.updateProjectNode(projectId, "basic-info", {
      markdown: "# 项目基本信息\n\n原始拼接内容。",
      status: "confirmed",
    });
    const master = "## 项目概述\n\n综合后的前言。";
    await exportProjectDocuments(store, projectId, master);
    const md = await readFile(path.join(rootDir, projectId, "exports", "PROJECT_DESIGN.md"), "utf8");
    expect(md).toContain("综合后的前言");
    expect(md).not.toContain("原始拼接");
  });
});