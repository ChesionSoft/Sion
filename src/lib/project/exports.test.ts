import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportProjectDocuments } from "./exports";
import { ProjectStore } from "./store";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "Sion-export-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("exportProjectDocuments", () => {
  it("writes Markdown outputs and Word document into project exports folder", async () => {
    const store = new ProjectStore(rootDir);
    const project = await store.createProject({
      name: "库存管理系统",
      customerName: "示例客户",
      authorName: "示例团队",
      now: "2026-06-14T10:00:00.000Z",
    });

    const result = await exportProjectDocuments(store, project.id);

    expect(result.files.map((file) => file.filename)).toEqual([
      "PROJECT_DESIGN.md",
      "项目开发设计文档.docx",
      "SPEC.md",
      "TASKS.md",
      "AGENTS.md",
    ]);

    const markdown = await readFile(path.join(rootDir, project.id, "exports", "PROJECT_DESIGN.md"), "utf8");
    expect(markdown).toContain("# 库存管理系统项目开发设计文档");

    const docx = await readFile(path.join(rootDir, project.id, "exports", "项目开发设计文档.docx"));
    expect(docx.byteLength).toBeGreaterThan(1000);
  });
});
