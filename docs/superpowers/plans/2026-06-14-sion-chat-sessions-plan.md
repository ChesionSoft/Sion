# Chat Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support multiple named chat sessions per workflow node so users can save, revisit, and switch between conversation histories.

**Architecture:** Extend ProjectStore with session management methods backed by `chat/<nodeId>/index.json` + `chat/<nodeId>/<sessionId>.json` files. Add session list/delete API routes. Update chat POST to accept optional sessionId. Rework ChatPanel layout: session selector in header, model/file selectors moved below input.

**Tech Stack:** TypeScript, Next.js App Router, React, Vitest

---

### Task 1: Add ChatSession type

**Files:**
- Modify: `src/lib/project/types.ts` (append after line 94)

- [ ] **Step 1: Add ChatSession type**

Append after `AgentOverrideSetting` type (after line 94):

```ts
export type ChatSession = {
  id: string;
  nodeId: WorkflowNodeId;
  name: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/project/types.ts
git commit -m "feat: add ChatSession type"
```

---

### Task 2: Extend ProjectStore with session methods

**Files:**
- Modify: `src/lib/project/store.ts`
- Modify: `src/lib/project/store.test.ts` (add session tests)

- [ ] **Step 1: Write failing tests for session methods**

Add to `src/lib/project/store.test.ts` after the existing `appendChatMessage` test. Also add `import { writeFile } from "node:fs/promises";` and `import path from "node:path";` at the top of the test file.

```ts
it("creates a session with auto-generated name", async () => {
  const store = new ProjectStore(rootDir);
  const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

  const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");
  expect(session.nodeId).toBe("feature-design");
  expect(session.name).toContain("6月");
  expect(session.messageCount).toBe(0);
});

it("lists sessions for a node sorted by newest first", async () => {
  const store = new ProjectStore(rootDir);
  const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

  const s1 = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");
  const s2 = await store.createSession(project.id, "feature-design", "2026-06-14T12:00:00.000Z");

  const sessions = await store.listSessions(project.id, "feature-design");
  expect(sessions).toHaveLength(2);
  expect(sessions[0].id).toBe(s2.id);
});

it("prunes sessions beyond 10", async () => {
  const store = new ProjectStore(rootDir);
  const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

  for (let i = 0; i < 12; i++) {
    await store.createSession(project.id, "feature-design", `2026-06-14T${String(10 + i).padStart(2, "0")}:00:00.000Z`);
  }

  const sessions = await store.listSessions(project.id, "feature-design");
  expect(sessions).toHaveLength(10);
});

it("appends and reads chat messages for a specific session", async () => {
  const store = new ProjectStore(rootDir);
  const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

  const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");

  await store.appendChatMessage(project.id, "feature-design", {
    id: "m-1", role: "user", content: "测试消息", createdAt: "2026-06-14T11:01:00.000Z",
  }, session.id);

  const messages = await store.getChatMessages(project.id, "feature-design", session.id);
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe("测试消息");
});

it("deletes a session and its message file", async () => {
  const store = new ProjectStore(rootDir);
  const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

  const session = await store.createSession(project.id, "feature-design", "2026-06-14T11:00:00.000Z");
  await store.appendChatMessage(project.id, "feature-design", {
    id: "m-1", role: "user", content: "测试", createdAt: "2026-06-14T11:01:00.000Z",
  }, session.id);

  await store.deleteSession(project.id, session.id);
  const sessions = await store.listSessions(project.id, "feature-design");
  expect(sessions).toHaveLength(0);
});

it("migrates legacy flat chat file into first session", async () => {
  const store = new ProjectStore(rootDir);
  const project = await store.createProject({ name: "CRM", now: "2026-06-14T10:00:00.000Z" });

  await writeFile(
    path.join(rootDir, project.id, "chat", "feature-design.json"),
    JSON.stringify([{ id: "old-1", role: "user", content: "旧消息", createdAt: "2026-06-14T09:00:00.000Z" }], null, 2),
    "utf8",
  );

  const sessions = await store.listSessions(project.id, "feature-design");
  expect(sessions).toHaveLength(1);
  expect(sessions[0].name).toContain("已迁移");

  const messages = await store.getChatMessages(project.id, "feature-design", sessions[0].id);
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe("旧消息");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/project/store.test.ts`
Expected: 6 new tests FAIL with "not a function" or similar

- [ ] **Step 3: Implement session methods in ProjectStore**

Modify `src/lib/project/store.ts`:

Add imports at top:
```ts
import { unlink } from "node:fs/promises";
import type { ChatSession } from "./types";
```

Add `formatSessionName` helper after the existing `writeJson` helper (before the class):
```ts
function formatSessionName(now: Date): string {
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hour}:${minute}`;
}
```

Add these methods to the ProjectStore class (before `projectDir`):

```ts
private sessionDir(projectId: string, nodeId: WorkflowNodeId): string {
  return path.join(this.projectDir(projectId), "chat", nodeId);
}

private sessionIndexPath(projectId: string, nodeId: WorkflowNodeId): string {
  return path.join(this.sessionDir(projectId, nodeId), "index.json");
}

private sessionMessagesPath(projectId: string, nodeId: WorkflowNodeId, sessionId: string): string {
  return path.join(this.sessionDir(projectId, nodeId), `${sessionId}.json`);
}

async createSession(projectId: string, nodeId: WorkflowNodeId, now?: string): Promise<ChatSession> {
  await mkdir(this.sessionDir(projectId, nodeId), { recursive: true });

  const createdAt = now ?? new Date().toISOString();
  const session: ChatSession = {
    id: randomUUID(),
    nodeId,
    name: formatSessionName(new Date(createdAt)),
    messageCount: 0,
    createdAt,
    updatedAt: createdAt,
  };

  const sessions = await this.listSessions(projectId, nodeId);
  sessions.unshift(session);

  if (sessions.length > 10) {
    const toRemove = sessions.splice(10);
    for (const s of toRemove) {
      try { await unlink(this.sessionMessagesPath(projectId, nodeId, s.id)); } catch { /* gone */ }
    }
  }

  await writeJson(this.sessionIndexPath(projectId, nodeId), sessions);
  await writeJson(this.sessionMessagesPath(projectId, nodeId, session.id), []);
  return session;
}

async listSessions(projectId: string, nodeId: WorkflowNodeId): Promise<ChatSession[]> {
  try {
    const sessions = await readJson<ChatSession[]>(this.sessionIndexPath(projectId, nodeId));
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    // Try legacy migration: if flat chat/<nodeId>.json exists, migrate to first session
    const legacyPath = this.chatPath(projectId, nodeId);
    try {
      const legacyMessages = await readJson<ChatMessage[]>(legacyPath);
      if (legacyMessages.length === 0) return [];

      await mkdir(this.sessionDir(projectId, nodeId), { recursive: true });
      const session: ChatSession = {
        id: randomUUID(),
        nodeId,
        name: `${formatSessionName(new Date())} (已迁移)`,
        messageCount: legacyMessages.length,
        createdAt: legacyMessages[0]?.createdAt ?? new Date().toISOString(),
        updatedAt: legacyMessages[legacyMessages.length - 1]?.createdAt ?? new Date().toISOString(),
      };
      await writeJson(this.sessionIndexPath(projectId, nodeId), [session]);
      await writeJson(this.sessionMessagesPath(projectId, nodeId, session.id), legacyMessages);
      try { await unlink(legacyPath); } catch { /* ok */ }
      return [session];
    } catch {
      return [];
    }
  }
}

async getChatMessages(projectId: string, nodeId: WorkflowNodeId, sessionId?: string): Promise<ChatMessage[]> {
  if (sessionId) {
    try {
      return await readJson<ChatMessage[]>(this.sessionMessagesPath(projectId, nodeId, sessionId));
    } catch {
      return [];
    }
  }
  // Legacy fallback
  return readJson<ChatMessage[]>(this.chatPath(projectId, nodeId));
}

async appendChatMessage(
  projectId: string,
  nodeId: WorkflowNodeId,
  message: ChatMessage,
  sessionId?: string,
): Promise<ChatMessage[]> {
  if (sessionId) {
    const messages = await this.getChatMessages(projectId, nodeId, sessionId);
    const next = [...messages, message];
    await writeJson(this.sessionMessagesPath(projectId, nodeId, sessionId), next);

    const sessions = await this.listSessions(projectId, nodeId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      session.messageCount = next.length;
      session.updatedAt = message.createdAt;
      await writeJson(this.sessionIndexPath(projectId, nodeId), sessions);
    }
    return next;
  }
  // Legacy fallback
  const messages = await this.getChatMessages(projectId, nodeId);
  const next = [...messages, message];
  await writeJson(this.chatPath(projectId, nodeId), next);
  return next;
}

async deleteSession(projectId: string, sessionId: string): Promise<void> {
  const nodes = await this.getProjectNodes(projectId);
  for (const node of nodes) {
    const sessions = await this.listSessions(projectId, node.id);
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index === -1) continue;

    const session = sessions[index];
    try { await unlink(this.sessionMessagesPath(projectId, node.id, session.id)); } catch { /* gone */ }
    sessions.splice(index, 1);
    await writeJson(this.sessionIndexPath(projectId, node.id), sessions);
    return;
  }
  throw new Error("会话不存在");
}
```

Keep the existing `chatPath` private method for legacy fallback.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/project/store.test.ts`
Expected: All store tests PASS (existing 4 + new 6 = 10)

- [ ] **Step 5: Commit**

```bash
git add src/lib/project/store.ts src/lib/project/store.test.ts
git commit -m "feat: add session management to ProjectStore"
```

---

### Task 3: Add session API routes

**Files:**
- Create: `src/app/api/projects/[projectId]/chat/sessions/route.ts`
- Create: `src/app/api/projects/[projectId]/chat/sessions/[sessionId]/route.ts`
- Create: `src/app/api/projects/[projectId]/chat/sessions/sessions-api.test.ts`

- [ ] **Step 1: Create GET sessions route**

Create directory `src/app/api/projects/[projectId]/chat/sessions/` and file `route.ts`:

```ts
import { NextResponse } from "next/server";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { ProjectStore } from "@/lib/project/store";

const store = new ProjectStore();

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const { searchParams } = new URL(request.url);
  const nodeId = searchParams.get("nodeId");

  if (!nodeId || !isWorkflowNodeId(nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 400 });
  }

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const sessions = await store.listSessions(projectId, nodeId);
  return NextResponse.json({ sessions });
}
```

- [ ] **Step 2: Create DELETE + GET session route**

Create directory `src/app/api/projects/[projectId]/chat/sessions/[sessionId]/` and file `route.ts`:

```ts
import { NextResponse } from "next/server";
import { ProjectStore } from "@/lib/project/store";

const store = new ProjectStore();

export async function GET(_request: Request, context: { params: Promise<{ projectId: string; sessionId: string }> }) {
  const { projectId, sessionId } = await context.params;

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  // Find which node this session belongs to
  const nodes = await store.getProjectNodes(projectId);
  for (const node of nodes) {
    const sessions = await store.listSessions(projectId, node.id);
    if (sessions.some((s) => s.id === sessionId)) {
      const messages = await store.getChatMessages(projectId, node.id, sessionId);
      return NextResponse.json({ messages });
    }
  }

  return NextResponse.json({ error: "会话不存在" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ projectId: string; sessionId: string }> }) {
  const { projectId, sessionId } = await context.params;

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  try {
    await store.deleteSession(projectId, sessionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "会话不存在") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
```

- [ ] **Step 3: Write API tests**

Create `src/app/api/projects/[projectId]/chat/sessions/sessions-api.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import { DELETE, GET as GET_SESSION } from "./[sessionId]/route";

let tmpDir: string;
const originalCwd = process.cwd;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-sessions-test-"));
  process.cwd = () => tmpDir;

  const projectsDir = path.join(tmpDir, "projects", "test-project");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(projectsDir, "nodes"), { recursive: true });
  await mkdir(path.join(projectsDir, "chat"), { recursive: true });
  await mkdir(path.join(projectsDir, "exports"), { recursive: true });

  const project = {
    id: "test-project", name: "测试项目", customerName: "", authorName: "",
    version: "V1.0", createdAt: "2026-06-14T10:00:00.000Z", updatedAt: "2026-06-14T10:00:00.000Z",
  };
  await writeFile(path.join(projectsDir, "project.json"), JSON.stringify(project, null, 2), "utf8");

  const nodeIds = ["basic-info", "goals", "roles-permissions", "business-flow",
    "feature-design", "page-interaction", "data-structure", "api-design",
    "architecture-deployment", "development-tasks", "risks-open-questions", "final-export"];
  for (const nid of nodeIds) {
    await writeFile(path.join(projectsDir, "nodes", `${nid}.json`),
      JSON.stringify({ id: nid, status: "draft", markdown: `# ${nid}`, assumptions: [], openQuestions: [], updatedAt: "2026-06-14T10:00:00.000Z" }, null, 2), "utf8");
  }
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("sessions API", () => {
  it("lists sessions for a node (empty initially)", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/test-project/chat/sessions?nodeId=feature-design"),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { sessions: unknown[] };
    expect(data.sessions).toEqual([]);
  });

  it("rejects invalid nodeId", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/test-project/chat/sessions?nodeId=invalid"),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );
    expect(response.status).toBe(400);
  });

  it("deletes a session", async () => {
    const { ProjectStore: PS } = await import("@/lib/project/store");
    const ps = new PS();
    const session = await ps.createSession("test-project", "feature-design");

    const response = await DELETE(
      new Request("http://localhost/api/projects/test-project/chat/sessions/delete", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "test-project", sessionId: session.id }) },
    );
    expect(response.status).toBe(200);
  });

  it("gets messages for a session", async () => {
    const { ProjectStore: PS } = await import("@/lib/project/store");
    const ps = new PS();
    const session = await ps.createSession("test-project", "feature-design");
    await ps.appendChatMessage("test-project", "feature-design", {
      id: "m-1", role: "user", content: "测试", createdAt: "2026-06-14T11:00:00.000Z",
    }, session.id);

    const response = await GET_SESSION(
      new Request("http://localhost/api/projects/test-project/chat/sessions/x"),
      { params: Promise.resolve({ projectId: "test-project", sessionId: session.id }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { messages: Array<{ content: string }> };
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].content).toBe("测试");
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/app/api/projects/[projectId]/chat/sessions/sessions-api.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/[projectId]/chat/sessions/
git commit -m "feat: add session list, get, and delete API routes"
```

---

### Task 4: Update chat POST route for sessionId

**Files:**
- Modify: `src/app/api/projects/[projectId]/chat/route.ts`
- Modify: `src/app/api/projects/[projectId]/chat/chat-api.test.ts`

- [ ] **Step 1: Update chat route to accept and use sessionId**

In `src/app/api/projects/[projectId]/chat/route.ts`:

Add `sessionId` to the body type (line 16-22):
```ts
  const body = (await request.json()) as {
    nodeId?: string;
    message?: string;
    providerId?: string;
    model?: string;
    fileIds?: string[];
    sessionId?: string;
  };
```

Replace the first `appendChatMessage` call (user message, currently lines 110-115) with session auto-create logic:
```ts
  let sessionId = body.sessionId;
  if (!sessionId) {
    const session = await projectStore.createSession(projectId, body.nodeId);
    sessionId = session.id;
  }

  await projectStore.appendChatMessage(projectId, body.nodeId, {
    id: randomUUID(),
    role: "user",
    content: body.message.trim(),
    createdAt: new Date().toISOString(),
  }, sessionId);
```

Replace the second `appendChatMessage` call (assistant message, currently lines 151-156):
```ts
  const messages = await projectStore.appendChatMessage(projectId, body.nodeId, {
    id: randomUUID(),
    role: "assistant",
    content: assistantContent,
    createdAt: new Date().toISOString(),
  }, sessionId);
```

Update the return statement to include `sessionId`:
```ts
  return NextResponse.json({ messages, assistantContent, sessionId });
```

- [ ] **Step 2: Update chat API test**

In `src/app/api/projects/[projectId]/chat/chat-api.test.ts`, update the success test assertion to also check `sessionId`:

After `expect(data.messages).toHaveLength(2);` add:
```ts
    expect(data.sessionId).toBeDefined();
    expect(typeof data.sessionId).toBe("string");
```

Add a new test for explicit sessionId:

```ts
  it("appends to an existing session when sessionId is provided", async () => {
    const { ProjectStore: PS } = await import("@/lib/project/store");
    const ps = new PS();
    const session = await ps.createSession("test-project", "feature-design");

    const response = await POST(
      new Request("http://localhost/api/projects/test-project/chat", {
        method: "POST",
        body: JSON.stringify({
          nodeId: "feature-design",
          message: "继续讨论",
          providerId: "mp-1",
          model: "test-model",
          sessionId: session.id,
        }),
      }),
      { params: Promise.resolve({ projectId: "test-project" }) },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { messages: Array<{ role: string }>; sessionId: string };
    expect(data.sessionId).toBe(session.id);
    expect(data.messages).toHaveLength(2);
  });
```

- [ ] **Step 3: Run tests**

Run: `npm test -- src/app/api/projects/[projectId]/chat/chat-api.test.ts`
Expected: All chat API tests PASS (existing 3 + new 1 = 4)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/projects/[projectId]/chat/route.ts src/app/api/projects/[projectId]/chat/chat-api.test.ts
git commit -m "feat: add sessionId support to chat route"
```

---

### Task 5: Update ChatPanel UI with session selector and reorder layout

**Files:**
- Modify: `src/components/workbench/chat-panel.tsx` (full rewrite)
- Modify: `src/components/workbench/workbench-shell.test.tsx` (update placeholder if needed)

- [ ] **Step 1: Rewrite ChatPanel with session support and reordered layout**

Replace `src/components/workbench/chat-panel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileIcon, PlusIcon, SendIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { ChatMessage, ChatSession, ModelProvider, ProjectFile, ProjectNode } from "@/lib/project/types";

export function ChatPanel({ activeNode, projectId }: { activeNode: ProjectNode; projectId: string }) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Session state
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");

  useEffect(() => {
    fetch("/api/settings/model-providers")
      .then((r) => r.json())
      .then((d: { providers: ModelProvider[] }) => {
        setProviders(d.providers);
        const def = d.providers.find((p) => p.isDefault);
        if (def) {
          setSelectedProviderId(def.id);
          setSelectedModel(def.defaultModel);
        }
      })
      .catch(() => setError("读取模型配置失败"));
  }, []);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/files`)
      .then((r) => r.json())
      .then((d: { files: ProjectFile[] }) => setProjectFiles(d.files))
      .catch(() => {});
  }, [projectId]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/chat/sessions?nodeId=${activeNode.id}`);
      const data = (await res.json()) as { sessions: ChatSession[] };
      if (res.ok && data.sessions) setSessions(data.sessions);
    } catch { /* ignore */ }
  }, [projectId, activeNode.id]);

  // On node change: reset and load sessions, select newest
  useEffect(() => {
    setMessages([]);
    setError("");
    setActiveSessionId("");
    refreshSessions();
  }, [refreshSessions]);

  function startNewSession() {
    setActiveSessionId("");
    setMessages([]);
    setError("");
  }

  async function switchSession(sessionId: string) {
    setActiveSessionId(sessionId);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/chat/sessions/${sessionId}`);
      const data = (await res.json()) as { messages?: ChatMessage[]; error?: string };
      setMessages(data.messages ?? []);
    } catch {
      setMessages([]);
    }
  }

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const selectedFiles = projectFiles.filter((f) => selectedFileIds.includes(f.id));
  const readableFiles = selectedFiles.filter((f) => f.status === "available");

  function toggleFile(fileId: string) {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId],
    );
  }

  async function sendMessage() {
    if (!message.trim() || sending) return;
    if (!selectedProviderId || !selectedModel) {
      setError("请先选择模型");
      return;
    }
    setError("");
    setSending(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: activeNode.id,
          message: message.trim(),
          providerId: selectedProviderId,
          model: selectedModel,
          fileIds: selectedFileIds,
          sessionId: activeSessionId || undefined,
        }),
      });
      const data = (await res.json()) as {
        messages?: ChatMessage[];
        sessionId?: string;
        error?: string;
      };

      if (!res.ok || !data.messages) {
        setError(data.error ?? "发送失败");
        return;
      }

      setMessages(data.messages);
      if (data.sessionId && !activeSessionId) {
        setActiveSessionId(data.sessionId);
        refreshSessions();
      }
      setMessage("");
    } catch {
      setError("请求失败，请检查网络连接");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <section className="flex min-h-0 flex-col border-r">
      {/* Header with session selector */}
      <div className="border-b px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">节点 Agent</p>
        <h2 className="text-sm font-semibold">{activeNode.id}</h2>
        <div className="mt-2 flex items-center gap-2">
          <select
            className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
            onChange={(e) => {
              const val = e.target.value;
              if (val === "__new__") startNewSession();
              else if (val) switchSession(val);
            }}
            value={activeSessionId || "__new__"}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.messageCount} 条消息)
              </option>
            ))}
            <option value="__new__">+ 新建会话</option>
          </select>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* Chat messages */}
        <ScrollArea className="min-h-0 flex-1" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              {activeSession
                ? `当前会话：${activeSession.name}。发送消息开始讨论。`
                : "新会话，发送消息开始讨论。"}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-lg p-3 text-sm ${
                    msg.role === "user"
                      ? "bg-primary/10 ml-8"
                      : msg.role === "assistant"
                        ? "bg-muted/30 mr-8"
                        : "bg-muted/10 mx-4 text-xs"
                  }`}
                >
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    {msg.role === "user" ? "你" : msg.role === "assistant" ? "Agent" : "系统"}
                  </p>
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Error */}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {/* Input */}
        <div className="flex flex-col gap-2">
          <Textarea
            className="min-h-28 resize-none"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="和当前节点 Agent 讨论... (Enter 发送，Shift+Enter 换行)"
            value={message}
          />
          <Button
            className="self-end"
            disabled={!message.trim() || sending || !selectedProviderId || !selectedModel}
            onClick={sendMessage}
            type="button"
          >
            <SendIcon data-icon="inline-start" />
            {sending ? "发送中..." : "发送"}
          </Button>
        </div>

        {/* Model selector — below input */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">模型选择</label>
          {providers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              暂无配置的模型提供商，请先在主菜单配置。
            </p>
          ) : (
            <div className="flex gap-2">
              <select
                className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
                onChange={(e) => {
                  setSelectedProviderId(e.target.value);
                  const p = providers.find((pr) => pr.id === e.target.value);
                  if (p) setSelectedModel(p.defaultModel);
                }}
                value={selectedProviderId}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {selectedProvider ? (
                <select
                  className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
                  onChange={(e) => setSelectedModel(e.target.value)}
                  value={selectedModel}
                >
                  {selectedProvider.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          )}
        </div>

        {/* File selector — below input */}
        {projectFiles.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">引用文件</label>
            <div className="flex flex-wrap gap-1">
              {projectFiles.map((file) => {
                const selected = selectedFileIds.includes(file.id);
                const canAttach = file.status === "available";
                return (
                  <button
                    key={file.id}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                      selected
                        ? "bg-primary/10 border-primary/30 text-primary"
                        : canAttach
                          ? "bg-background hover:bg-muted/50"
                          : "bg-background opacity-50 cursor-not-allowed"
                    }`}
                    disabled={!canAttach}
                    onClick={() => toggleFile(file.id)}
                    title={
                      !canAttach
                        ? "此文件不支持读取"
                        : file.characterCount && file.characterCount > 50000
                          ? `文件较大（${file.characterCount.toLocaleString()} 字符），可能消耗较多 Token`
                          : undefined
                    }
                    type="button"
                  >
                    <FileIcon className="h-3 w-3" />
                    {file.originalName}
                    {!canAttach ? (
                      <Badge className="text-[10px] px-1 py-0" variant="outline">
                        不支持
                      </Badge>
                    ) : null}
                    {selected ? <XIcon className="h-3 w-3" /> : null}
                  </button>
                );
              })}
            </div>
            {readableFiles.some(
              (f) => f.characterCount && f.characterCount > 50000,
            ) ? (
              <p className="text-xs text-amber-600">
                部分选中文件较大，可能消耗较多 Token 并增加响应时间。
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests PASS. If the workbench-shell test fails due to placeholder text, update `src/components/workbench/workbench-shell.test.tsx` line 37 to match the current placeholder.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/workbench/chat-panel.tsx
git commit -m "feat: add session selector and reorder chat panel layout"
```

---

### Task 6: Browser verification

- [ ] **Step 1: Start dev server and verify flows**

```bash
npm run dev &
```

Verify:
1. Open main page → configure a model provider
2. Open a project → session dropdown shows in chat header
3. Send a message → session auto-created, appears in dropdown with message count
4. Select "+ 新建会话" from dropdown → messages clear, new session starts
5. Send message in new session → new session appears in list
6. Switch between sessions → messages load for each
7. Model selector and file selector are below the input area

- [ ] **Step 2: Stop dev server and commit any final fixes**
