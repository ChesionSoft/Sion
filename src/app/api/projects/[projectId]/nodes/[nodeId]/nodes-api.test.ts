import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import { PATCH } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-nodes-api-"));
  process.cwd = () => tmpDir;
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("nodes API", () => {
  it("returns 404 when the project does not exist", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/projects/missing-project/nodes/feature-design", {
        method: "PATCH",
        body: JSON.stringify({ markdown: "# x" }),
      }),
      { params: Promise.resolve({ projectId: "missing-project", nodeId: "feature-design" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "项目不存在" });
  });

  it("updates a node markdown for an existing project", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/feature-design`, {
        method: "PATCH",
        body: JSON.stringify({ markdown: "# 功能模块设计\n\n- 客户管理", status: "confirmed" }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "feature-design" }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { node: { markdown: string; status: string } };
    expect(data.node.markdown).toContain("- 客户管理");
    expect(data.node.status).toBe("confirmed");
  });

  it("returns 404 for an unknown node id", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/unknown`, {
        method: "PATCH",
        body: JSON.stringify({ markdown: "# x" }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "unknown" }) },
    );
    expect(response.status).toBe(404);
  });
});