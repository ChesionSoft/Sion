import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import type { ProjectNode } from "@/lib/project/types";
import type { ProjectStore } from "@/lib/project/store";

// ---------------------------------------------------------------------------
// Conflict-mode toggle (used by the vi.mock below)
// ---------------------------------------------------------------------------
let __conflictMode = false;

// Mock the store module so we can inject conflict behavior for test 6.
// For non-conflict tests the mock delegates to the real store.
vi.mock("@/lib/project/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project/store")>();
  const RealStore: typeof actual.ProjectStore = actual.ProjectStore;
  const Conflict = actual.NodeRevisionConflictError;

  class MockStore extends RealStore {
    async getProject(projectId: string) {
      if (__conflictMode) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { id: projectId, name: "Mock" } as any;
      }
      return super.getProject(projectId);
    }

    async getProjectNodes(projectId: string) {
      if (__conflictMode) {
        return [
          getMockNodeAtRevision(1),
        ];
      }
      return super.getProjectNodes(projectId);
    }

    async updateProjectNodeIfRevision(
      projectId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodeId: any,
      expectedRevision: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      patch: any,
    ) {
      if (__conflictMode) {
        throw new Conflict(getMockConflictNode(nodeId));
      }
      return super.updateProjectNodeIfRevision(projectId, nodeId, expectedRevision, patch);
    }
  }

  return { ...actual, ProjectStore: MockStore };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// Uses the `goals` node, whose "建设目标" section (sectionKey `goals`) is a
// bullet section — needed because `feature-design` no longer has a bullet
// section after the confirmed/assumptions/open_questions meta-sections were
// removed.

const NODE_ID = "goals";

function getMockNodeAtRevision(revision: number): ProjectNode {
  return {
    id: NODE_ID,
    status: "draft",
    markdown:
      "# 2. 需求背景与建设目标\n\n## 需求背景\n\n背景说明\n\n## 建设目标\n\n- 已有项\n\n## 范围边界\n\n- 边界1\n",
    revision,
    updatedAt: new Date().toISOString(),
  };
}

function getMockConflictNode(nodeId: string): ProjectNode {
  return {
    id: nodeId as ProjectNode["id"],
    status: "draft",
    markdown: "some content",
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
}

function validPatch(overrides: Record<string, unknown> = {}) {
  return {
    category: "confirmed_fact",
    targetSectionKey: "goals",
    patchKind: "append_bullet",
    markdown: "- 新需求项",
    evidence: { source: "user", quote: "用户要求" },
    ...overrides,
  };
}

async function createProjectInRealStore(): Promise<{
  store: ProjectStore;
  project: { id: string };
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RealStore = (await vi.importActual<any>("@/lib/project/store")).ProjectStore;
  const store = new RealStore() as ProjectStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const project = await store.createProject({ name: "Test", now: "2026-06-20T00:00:00.000Z" }) as any;
  return { store, project };
}

let tmpDir: string;
const originalCwd = process.cwd;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-patch-api-"));
  process.cwd = () => tmpDir;
  __conflictMode = false;
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("patch API", () => {
  // -- 1. Request shape 400 -----------------------------------------------
  // Note: route checks project/node existence first, so body-shape tests use
  // a real project.

  it("returns 400 when body is empty", async () => {
    const { project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when patches is missing", async () => {
    const { project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when expectedRevision is missing", async () => {
    const { project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({ patches: [] }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when expectedRevision is NaN", async () => {
    const { project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({ patches: [], expectedRevision: NaN }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(400);
  });

  // -- 404 cases -----------------------------------------------------------

  it("returns 404 when project does not exist", async () => {
    const response = await POST(
      new Request(`http://localhost/api/projects/nonexistent/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({ patches: [validPatch()], expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "nonexistent", nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown node id", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/x/nodes/unknown/patch", {
        method: "POST",
        body: JSON.stringify({ patches: [validPatch()], expectedRevision: 0 }),
      }),
      { params: Promise.resolve({ projectId: "x", nodeId: "unknown" }) },
    );
    expect(response.status).toBe(404);
  });

  // -- 2. Per-patch validation 422 -----------------------------------------

  it("returns 422 when a patch has an invalid category", async () => {
    const { store, project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [validPatch({ category: "invalid" })],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(422);
    // Disk unchanged
    const nodes = await store.getProjectNodes(project.id);
    const node = nodes.find((n) => n.id === NODE_ID);
    expect(node!.revision).toBe(0);
  });

  it("returns 422 when a patch has unknown targetSectionKey", async () => {
    const { project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [validPatch({ targetSectionKey: "nonexistent" })],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(422);
  });

  it("returns 422 when a patch has markdown with heading lines", async () => {
    const { project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [validPatch({ markdown: "## subheading\n- foo" })],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(422);
  });

  it("returns 422 when a patch has an invalid patchKind for the section", async () => {
    const { project } = await createProjectInRealStore();
    // "goals" section only allows append_bullet, not append_table_row
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [
            validPatch({
              patchKind: "append_table_row",
              markdown: "| col1 | col2 | col3 |",
            }),
          ],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(422);
  });

  // -- 3. Revision match success -------------------------------------------

  it("applies patches and returns updated node on success", async () => {
    const { project } = await createProjectInRealStore();
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [validPatch({ markdown: "- 新需求项" })],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      node: { revision: number; status: string; markdown: string };
      replayed: boolean;
    };
    expect(data.node.revision).toBe(1);
    expect(data.node.status).toBe("generated");
    expect(data.node.markdown).toContain("- 新需求项");
    expect(data.replayed).toBe(false);
  });

  // -- 4. Stale revision → replay succeeds, content inserted once ----------

  it("replays on stale revision and inserts content exactly once", async () => {
    const { store, project } = await createProjectInRealStore();

    // Bump revision to 1 by adding "- 既有条目"
    await store.updateProjectNodeIfRevision(
      project.id,
      NODE_ID,
      0,
      {
        markdown:
          "# 2. 需求背景与建设目标\n\n## 需求背景\n\n背景说明\n\n## 建设目标\n\n- 既有条目\n\n## 范围边界\n\n- 边界1\n",
        status: "draft",
      },
    );

    // Now POST with expectedRevision: 0 (stale)
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [validPatch({ markdown: "- 新条目" })],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      node: { revision: number; markdown: string };
      replayed: boolean;
    };
    // replayed flag true because expectedRevision didn't match
    expect(data.replayed).toBe(true);
    expect(data.node.revision).toBe(2);
    // Both items present
    expect(data.node.markdown).toContain("- 既有条目");
    expect(data.node.markdown).toContain("- 新条目");
    // New bullet appears exactly once
    const matches = data.node.markdown.match(/- 新条目/g);
    expect(matches).toHaveLength(1);
  });

  // -- 5. Deleted target section → schema-ordered creation -----------------

  it("creates missing section when replaying onto markdown without target", async () => {
    const { store, project } = await createProjectInRealStore();

    // Replace the node's markdown with one that has NO "建设目标" section
    const markdownWithoutTarget =
      "# 2. 需求背景与建设目标\n\n## 需求背景\n\n背景说明\n\n## 范围边界\n\n- 边界1\n";
    await store.updateProjectNodeIfRevision(
      project.id,
      NODE_ID,
      0,
      { markdown: markdownWithoutTarget, status: "draft" },
    );
    // Now revision is 1, markdown has no "建设目标"

    // POST with expectedRevision: 0 — stale, will replay onto latest
    // The "建设目标" section should be created via schema-order insertion
    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [validPatch({ markdown: "- 新需求项" })],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      node: { revision: number; markdown: string };
      replayed: boolean;
    };
    expect(data.replayed).toBe(true);
    expect(data.node.markdown).toContain("## 建设目标");
    expect(data.node.markdown).toContain("- 新需求项");
    // Schema order: 建设目标 comes before 范围边界
    const goalsSectionIdx = data.node.markdown.indexOf("## 建设目标");
    const scopeIdx = data.node.markdown.indexOf("## 范围边界");
    expect(goalsSectionIdx).toBeGreaterThan(0);
    expect(scopeIdx).toBeGreaterThan(goalsSectionIdx);
  });

  // -- 6. Second CAS conflict → 409 with latestNode -----------------------

  it("returns 409 with latestNode on second CAS conflict", async () => {
    __conflictMode = true;

    const response = await POST(
      new Request(`http://localhost/api/projects/mock/nodes/${NODE_ID}/patch`, {
        method: "POST",
        body: JSON.stringify({
          patches: [validPatch()],
          expectedRevision: 0,
        }),
      }),
      { params: Promise.resolve({ projectId: "mock", nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(409);
    const data = (await response.json()) as { error: string; latestNode: { revision: number } };
    expect(data.latestNode.revision).toBe(1);
  });
});