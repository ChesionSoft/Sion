import { render, screen } from "@testing-library/react";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExportCenterPage from "./page";

let tmpDir: string;
const originalCwd = process.cwd;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-exports-page-"));
  process.cwd = () => tmpDir;
  const projectsDir = path.join(tmpDir, "projects", "test-project");
  await mkdir(path.join(projectsDir, "exports"), { recursive: true });
  await writeFile(
    path.join(projectsDir, "project.json"),
    JSON.stringify(
      { id: "test-project", name: "测试项目", createdAt: "2026-06-14T10:00:00.000Z", updatedAt: "2026-06-14T10:00:00.000Z" },
      null,
      2,
    ),
    "utf8",
  );
  // ExportCenter fetches providers on mount; stub fetch so the effect resolves.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ providers: [] }), { status: 200 })),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("exports page", () => {
  it("renders the export center with the project name", async () => {
    const ui = await ExportCenterPage({ params: Promise.resolve({ projectId: "test-project" }) });
    render(ui);
    expect(screen.getByText("测试项目")).toBeInTheDocument();
    expect(screen.getByText("导出中心")).toBeInTheDocument();
  });
});
