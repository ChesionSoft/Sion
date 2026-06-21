import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import { GET, POST } from "./route";
import { DELETE, GET as GET_SESSION, PATCH } from "./[sessionId]/route";

let tmpDir: string;
const originalCwd = process.cwd;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-chat-session-api-"));
  process.cwd = () => tmpDir;
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("chat sessions API", () => {
  it("requires a workflow node id when listing sessions", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/p-1/chat/sessions"),
      { params: Promise.resolve({ projectId: "p-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "流程节点不存在" });
  });

  it("lists chat sessions for a node", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await GET(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions?nodeId=feature-design`),
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { sessions: Array<{ id: string }> };
    expect(data.sessions.map((item) => item.id)).toEqual([session.id]);
  });

  it("creates a chat session for a node", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    const response = await POST(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions`, {
        method: "POST",
        body: JSON.stringify({ nodeId: "feature-design" }),
      }),
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(201);
    const data = (await response.json()) as { session: { nodeId: string; id: string } };
    expect(data.session.nodeId).toBe("feature-design");
    expect(await store.listSessions(project.id, "feature-design")).toHaveLength(1);
  });

  it("deletes a chat session", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await DELETE(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/${session.id}`),
      { params: Promise.resolve({ projectId: project.id, sessionId: session.id }) },
    );

    expect(response.status).toBe(200);
    expect(await store.listSessions(project.id, "feature-design")).toEqual([]);
  });

  it("loads messages for a chat session", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");
    await store.appendChatMessage(
      project.id,
      "feature-design",
      {
        id: "m-1",
        role: "user",
        content: "历史消息",
        createdAt: "2026-06-14T11:01:00.000Z",
      },
      session.id,
    );

    const response = await GET_SESSION(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/${session.id}?nodeId=feature-design`),
      { params: Promise.resolve({ projectId: project.id, sessionId: session.id }) },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { messages: Array<{ content: string }>; sessionId: string };
    expect(data.sessionId).toBe(session.id);
    expect(data.messages[0].content).toBe("历史消息");
  });

  it("returns 404 when deleting a missing session in an existing project", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const response = await DELETE(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/missing`),
      { params: Promise.resolve({ projectId: project.id, sessionId: "missing" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "会话不存在" });
  });

  it("returns 404 when the project does not exist (list sessions)", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/missing-proj/chat/sessions?nodeId=feature-design"),
      { params: Promise.resolve({ projectId: "missing-proj" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "项目不存在" });
  });

  it("returns 404 when the project does not exist (create session)", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/missing-proj/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ nodeId: "feature-design" }),
      }),
      { params: Promise.resolve({ projectId: "missing-proj" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "项目不存在" });
  });

  it("returns 404 when the project does not exist (load messages)", async () => {
    const response = await GET_SESSION(
      new Request("http://localhost/api/projects/missing-proj/chat/sessions/sess?nodeId=feature-design"),
      { params: Promise.resolve({ projectId: "missing-proj", sessionId: "sess" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "项目不存在" });
  });

  it("returns 404 when the project does not exist (delete session)", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/projects/missing-proj/chat/sessions/sess"),
      { params: Promise.resolve({ projectId: "missing-proj", sessionId: "sess" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "项目不存在" });
  });

  it("patches the session web search preference", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ nodeId: "feature-design", webSearchEnabled: true }),
      }),
      { params: Promise.resolve({ projectId: project.id, sessionId: session.id }) },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { session: { webSearchEnabled: boolean; id: string } };
    expect(data.session.id).toBe(session.id);
    expect(data.session.webSearchEnabled).toBe(true);

    const fetched = await store.getSession(project.id, "feature-design", session.id);
    expect(fetched.webSearchEnabled).toBe(true);
  });

  it("returns 400 when patching with an invalid body", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ nodeId: "feature-design" }),
      }),
      { params: Promise.resolve({ projectId: project.id, sessionId: session.id }) },
    );

    expect(response.status).toBe(400);
    const fetched = await store.getSession(project.id, "feature-design", session.id);
    expect(fetched.webSearchEnabled).toBe(false);
  });

  it("returns 400 when patching an unknown node", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ nodeId: "not-a-node", webSearchEnabled: true }),
      }),
      { params: Promise.resolve({ projectId: project.id, sessionId: session.id }) },
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when patching a session that belongs to a different node", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });
    const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ nodeId: "basic-info", webSearchEnabled: true }),
      }),
      { params: Promise.resolve({ projectId: project.id, sessionId: session.id }) },
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 when patching a missing session in an existing project", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}/chat/sessions/missing`, {
        method: "PATCH",
        body: JSON.stringify({ nodeId: "feature-design", webSearchEnabled: true }),
      }),
      { params: Promise.resolve({ projectId: project.id, sessionId: "missing" }) },
    );

    expect(response.status).toBe(404);
  });
});
