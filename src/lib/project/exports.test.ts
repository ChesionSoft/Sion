import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveBlueprintArtifact,
  approveDraftArtifact,
  canFinalize,
  exportProjectDocuments,
  finalizeFormalPrdExport,
  readStageState,
  writeBlueprintArtifact,
  writeDraftArtifact,
} from "./exports";
import type { DocxQaReport } from "./docx-qa";
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
  await store.updateProjectNode(projectId, "goals", { status: "confirmed" });
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

  it("rejects approval when the blueprint file changed after it was generated", async () => {
    const state = await writeBlueprintArtifact(store, projectId, blueprint);
    await writeFile(store.exportPath(projectId, "export-blueprint.md"), "# 已被改写的蓝图\n", "utf8");

    await expect(approveBlueprintArtifact(store, projectId, state.blueprintDigest!)).rejects.toThrow("摘要不匹配");
  });

  it("rejects a blueprint that maps included content to an unconfirmed node", async () => {
    const invalidBlueprint: FormalPrdBlueprint = {
      ...blueprint,
      sections: [{ ...blueprint.sections[0], sourceNodeIds: ["basic-info"] }],
    };

    await expect(writeBlueprintArtifact(store, projectId, invalidBlueprint)).rejects.toThrow("已确认");
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

  it("removes prior Word and QA artifacts when a new blueprint is generated", async () => {
    await writeBlueprintArtifact(store, projectId, blueprint);
    const docxPath = store.exportPath(projectId, "项目开发设计文档.docx");
    const reportPath = store.exportPath(projectId, "formal-prd-qa-report.md");
    await writeFile(docxPath, "old docx");
    await writeFile(reportPath, "old report");

    await writeBlueprintArtifact(store, projectId, blueprint);

    expect(existsSync(docxPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
  });

  it("removes prior Word and QA artifacts when a new draft is generated", async () => {
    const bp = await writeBlueprintArtifact(store, projectId, blueprint);
    await approveBlueprintArtifact(store, projectId, bp.blueprintDigest!);
    const docxPath = store.exportPath(projectId, "项目开发设计文档.docx");
    const reportPath = store.exportPath(projectId, "formal-prd-qa-report.md");
    await writeFile(docxPath, "old docx");
    await writeFile(reportPath, "old report");

    await writeDraftArtifact(store, projectId, "## 执行摘要\n\n更新后的正文。");

    expect(existsSync(docxPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
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

describe("finalizeFormalPrdExport", () => {
  async function approveFullFlow() {
    const bp = await writeBlueprintArtifact(store, projectId, blueprint);
    await approveBlueprintArtifact(store, projectId, bp.blueprintDigest!);
    const draft = await writeDraftArtifact(store, projectId, "## 执行摘要\n\n已确认正文。");
    await approveDraftArtifact(store, projectId, draft.draftDigest!);
  }

  const fakeDocx = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00]);
  const passedReport: DocxQaReport = { passed: true, structuralUnitCount: 1, issues: [], checkedAt: "2026-07-11T00:00:00.000Z" };
  const failedReport: DocxQaReport = {
    passed: false,
    structuralUnitCount: 1,
    issues: [{ code: "missing_cjk_text", message: "未检出中文字符" }],
    checkedAt: "2026-07-11T00:00:00.000Z",
  };

  it("throws when the flow is not fully approved", async () => {
    await expect(finalizeFormalPrdExport(store, projectId)).rejects.toThrow();
  });

  it("returns 422 and removes the docx when QA fails, persisting the QA report", async () => {
    await approveFullFlow();
    const result = await finalizeFormalPrdExport(store, projectId, {
      buildDocx: async () => fakeDocx,
      runDocxQa: async () => failedReport,
    });
    expect(result.status).toBe(422);
    expect(result.qaReport.passed).toBe(false);
    // the failed DOCX is removed so it cannot be downloaded
    expect(existsSync(path.join(rootDir, projectId, "exports", "项目开发设计文档.docx"))).toBe(false);
    // the QA report is retained for review
    const report = await readFile(path.join(rootDir, projectId, "exports", "formal-prd-qa-report.md"), "utf8");
    expect(report).toContain("missing_cjk_text");
    expect((await readStageState(store, projectId)).qaStatus).toBe("failed");
  });

  it("returns 200, keeps the docx, and writes the internal exports when QA passes", async () => {
    await approveFullFlow();
    const result = await finalizeFormalPrdExport(store, projectId, {
      buildDocx: async () => fakeDocx,
      runDocxQa: async () => passedReport,
    });
    expect(result.status).toBe(200);
    expect(existsSync(path.join(rootDir, projectId, "exports", "项目开发设计文档.docx"))).toBe(true);
    expect(existsSync(path.join(rootDir, projectId, "exports", "formal-prd-qa-report.md"))).toBe(true);
    // the four internal markdown exports are written alongside the formal docx
    expect(existsSync(path.join(rootDir, projectId, "exports", "PROJECT_DESIGN.md"))).toBe(true);
    expect(existsSync(path.join(rootDir, projectId, "exports", "AGENTS.md"))).toBe(true);
    expect((await readStageState(store, projectId)).qaStatus).toBe("passed");
  });

  it("rejects finalization when the approved draft file changed", async () => {
    await approveFullFlow();
    await writeFile(store.exportPath(projectId, "formal-prd-draft.md"), "## 执行摘要\n\n篡改后的正文。", "utf8");

    await expect(
      finalizeFormalPrdExport(store, projectId, {
        buildDocx: async () => fakeDocx,
        runDocxQa: async () => passedReport,
      }),
    ).rejects.toThrow("摘要不匹配");
  });
});
