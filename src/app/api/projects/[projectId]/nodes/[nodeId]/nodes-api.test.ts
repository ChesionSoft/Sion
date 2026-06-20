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

  it("saves node as draft with incremented revision on success", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/feature-design`, {
        method: "PATCH",
        body: JSON.stringify({ markdown: "new content", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "feature-design" }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { node: { markdown: string; revision: number; status: string } };
    expect(data.node.revision).toBe(1);
    expect(data.node.markdown).toBe("new content");
    expect(data.node.status).toBe("draft");
  });

  it("returns 400 when markdown is missing", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/feature-design`, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "feature-design" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when expectedRevision is missing", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/feature-design`, {
        method: "PATCH",
        body: JSON.stringify({ markdown: "x" }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "feature-design" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 409 with latestNode on stale revision", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    // First save: revision 0 → 1
    const firstResponse = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/feature-design`, {
        method: "PATCH",
        body: JSON.stringify({ markdown: "first content", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "feature-design" }) },
    );
    expect(firstResponse.status).toBe(200);
    const firstData = (await firstResponse.json()) as { node: { revision: number } };
    expect(firstData.node.revision).toBe(1);

    // Second save with stale revision 0 → 409
    const staleResponse = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/feature-design`, {
        method: "PATCH",
        body: JSON.stringify({ markdown: "stale content", expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "feature-design" }) },
    );
    expect(staleResponse.status).toBe(409);
    const staleData = (await staleResponse.json()) as {
      error: string;
      latestNode: { revision: number; markdown: string };
    };
    expect(staleData.latestNode.revision).toBe(1);
    expect(staleData.latestNode.markdown).toBe("first content");

    // Verify disk unchanged: re-read node, markdown is still "first content"
    const nodes = await store.getProjectNodes(project.id);
    const node = nodes.find((n) => n.id === "feature-design")!;
    expect(node.markdown).toBe("first content");
    expect(node.revision).toBe(1);
  });

  it("ignores client-provided status, always writes draft", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/nodes/feature-design`, {
        method: "PATCH",
        body: JSON.stringify({ markdown: "x", expectedRevision: 0, status: "confirmed" }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: "feature-design" }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { node: { status: string } };
    expect(data.node.status).toBe("draft");
  });
});
