import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDefaultProject, createDefaultProjectNodes } from "./defaults";
import { WORKFLOW_NODES, isWorkflowNodeId } from "./nodes";
import { assertSafeProjectId } from "./paths";
import type { ChatMessage, ChatSession, Project, ProjectNode, WorkflowNodeId } from "./types";

export type CreateProjectInput = {
  name: string;
  customerName?: string;
  authorName?: string;
  now?: string;
};

export class ProjectStore {
  constructor(private readonly rootDir = path.join(process.cwd(), "projects")) {}

  async listProjects(): Promise<Project[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const projects = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.getProject(entry.name)),
    );

    return projects
      .filter((project): project is Project => Boolean(project))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const id = randomUUID();
    const project = createDefaultProject({ ...input, id });
    const projectDir = this.projectDir(id);

    await mkdir(path.join(projectDir, "nodes"), { recursive: true });
    await mkdir(path.join(projectDir, "chat"), { recursive: true });
    await mkdir(path.join(projectDir, "exports"), { recursive: true });
    await writeJson(path.join(projectDir, "project.json"), project);

    for (const node of createDefaultProjectNodes(project.createdAt)) {
      await writeJson(this.nodePath(id, node.id), node);
      await mkdir(this.chatNodeDir(id, node.id), { recursive: true });
      await writeJson(this.sessionIndexPath(id, node.id), []);
    }

    return project;
  }

  async getProject(projectId: string): Promise<Project | null> {
    try {
      return await readJson<Project>(path.join(this.projectDir(projectId), "project.json"));
    } catch {
      return null;
    }
  }

  async getProjectNodes(projectId: string): Promise<ProjectNode[]> {
    const nodes = await Promise.all(WORKFLOW_NODES.map((node) => readJson<ProjectNode>(this.nodePath(projectId, node.id))));
    return nodes.sort(
      (a, b) =>
        WORKFLOW_NODES.findIndex((node) => node.id === a.id) -
        WORKFLOW_NODES.findIndex((node) => node.id === b.id),
    );
  }

  async updateProjectNode(projectId: string, nodeId: WorkflowNodeId, patch: Partial<ProjectNode>): Promise<ProjectNode> {
    if (!isWorkflowNodeId(nodeId)) {
      throw new Error(`Unknown workflow node: ${nodeId}`);
    }

    const current = await readJson<ProjectNode>(this.nodePath(projectId, nodeId));
    const next: ProjectNode = {
      ...current,
      ...patch,
      id: nodeId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    await writeJson(this.nodePath(projectId, nodeId), next);
    return next;
  }

  async createSession(projectId: string, nodeId: WorkflowNodeId, now = new Date().toISOString()): Promise<ChatSession> {
    if (!isWorkflowNodeId(nodeId)) {
      throw new Error(`Unknown workflow node: ${nodeId}`);
    }

    await this.migrateLegacyChat(projectId, nodeId);
    await mkdir(this.chatNodeDir(projectId, nodeId), { recursive: true });

    const session: ChatSession = {
      id: randomUUID(),
      nodeId,
      name: formatSessionName(now),
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const sessions = [session, ...(await this.readSessionIndex(projectId, nodeId))].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    const kept = sessions.slice(0, 10);
    const pruned = sessions.slice(10);

    await writeJson(this.sessionMessagesPath(projectId, nodeId, session.id), []);
    for (const item of pruned) {
      await rm(this.sessionMessagesPath(projectId, nodeId, item.id), { force: true });
    }
    await writeJson(this.sessionIndexPath(projectId, nodeId), kept);

    return session;
  }

  async listSessions(projectId: string, nodeId: WorkflowNodeId): Promise<ChatSession[]> {
    if (!isWorkflowNodeId(nodeId)) {
      throw new Error(`Unknown workflow node: ${nodeId}`);
    }

    await this.migrateLegacyChat(projectId, nodeId);
    return (await this.readSessionIndex(projectId, nodeId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getChatMessages(projectId: string, nodeId: WorkflowNodeId, sessionId?: string): Promise<ChatMessage[]> {
    const session = await this.resolveSession(projectId, nodeId, sessionId);
    return readJson<ChatMessage[]>(this.sessionMessagesPath(projectId, nodeId, session.id));
  }

  async appendChatMessage(
    projectId: string,
    nodeId: WorkflowNodeId,
    message: ChatMessage,
    sessionId?: string,
  ): Promise<ChatMessage[]> {
    const session = await this.resolveSession(projectId, nodeId, sessionId, message.createdAt);
    const messages = await this.getChatMessages(projectId, nodeId, session.id);
    const next = [...messages, message];
    await writeJson(this.sessionMessagesPath(projectId, nodeId, session.id), next);
    await this.updateSession(projectId, nodeId, session.id, {
      messageCount: next.length,
      updatedAt: message.createdAt,
    });
    return next;
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    for (const node of WORKFLOW_NODES) {
      await this.migrateLegacyChat(projectId, node.id);
      const sessions = await this.readSessionIndex(projectId, node.id);
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) continue;

      const [session] = sessions.splice(index, 1);
      await rm(this.sessionMessagesPath(projectId, node.id, session.id), { force: true });
      await writeJson(this.sessionIndexPath(projectId, node.id), sessions);
      return;
    }

    throw new Error("会话不存在");
  }

  projectDir(projectId: string): string {
    assertSafeProjectId(projectId);
    return path.join(this.rootDir, projectId);
  }

  exportPath(projectId: string, filename: string): string {
    return path.join(this.projectDir(projectId), "exports", filename);
  }

  private nodePath(projectId: string, nodeId: WorkflowNodeId): string {
    return path.join(this.projectDir(projectId), "nodes", `${nodeId}.json`);
  }

  private legacyChatPath(projectId: string, nodeId: WorkflowNodeId): string {
    return path.join(this.projectDir(projectId), "chat", `${nodeId}.json`);
  }

  private chatNodeDir(projectId: string, nodeId: WorkflowNodeId): string {
    return path.join(this.projectDir(projectId), "chat", nodeId);
  }

  private sessionIndexPath(projectId: string, nodeId: WorkflowNodeId): string {
    return path.join(this.chatNodeDir(projectId, nodeId), "index.json");
  }

  private sessionMessagesPath(projectId: string, nodeId: WorkflowNodeId, sessionId: string): string {
    return path.join(this.chatNodeDir(projectId, nodeId), `${sessionId}.json`);
  }

  private async readSessionIndex(projectId: string, nodeId: WorkflowNodeId): Promise<ChatSession[]> {
    try {
      return await readJson<ChatSession[]>(this.sessionIndexPath(projectId, nodeId));
    } catch {
      return [];
    }
  }

  private async resolveSession(
    projectId: string,
    nodeId: WorkflowNodeId,
    sessionId?: string,
    now = new Date().toISOString(),
  ): Promise<ChatSession> {
    const sessions = await this.listSessions(projectId, nodeId);

    if (sessionId) {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        throw new Error("会话不存在");
      }
      return session;
    }

    return sessions[0] ?? this.createSession(projectId, nodeId, now);
  }

  private async updateSession(
    projectId: string,
    nodeId: WorkflowNodeId,
    sessionId: string,
    patch: Pick<ChatSession, "messageCount" | "updatedAt">,
  ): Promise<void> {
    const sessions = await this.readSessionIndex(projectId, nodeId);
    const index = sessions.findIndex((session) => session.id === sessionId);

    if (index === -1) {
      throw new Error("会话不存在");
    }

    sessions[index] = {
      ...sessions[index],
      ...patch,
    };
    await writeJson(this.sessionIndexPath(projectId, nodeId), sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  private async migrateLegacyChat(projectId: string, nodeId: WorkflowNodeId): Promise<void> {
    const legacyPath = this.legacyChatPath(projectId, nodeId);
    const existingSessions = await this.readSessionIndex(projectId, nodeId);

    if (existingSessions.length > 0) {
      return;
    }

    let legacyMessages: ChatMessage[];
    try {
      legacyMessages = await readJson<ChatMessage[]>(legacyPath);
    } catch {
      await mkdir(this.chatNodeDir(projectId, nodeId), { recursive: true });
      await writeJson(this.sessionIndexPath(projectId, nodeId), []);
      return;
    }

    const firstMessageTime = legacyMessages[0]?.createdAt ?? new Date().toISOString();
    const latestMessageTime = legacyMessages.at(-1)?.createdAt ?? firstMessageTime;
    const session: ChatSession = {
      id: randomUUID(),
      nodeId,
      name: formatSessionName(firstMessageTime),
      messageCount: legacyMessages.length,
      createdAt: firstMessageTime,
      updatedAt: latestMessageTime,
    };

    await mkdir(this.chatNodeDir(projectId, nodeId), { recursive: true });
    await writeJson(this.sessionMessagesPath(projectId, nodeId, session.id), legacyMessages);
    await writeJson(this.sessionIndexPath(projectId, nodeId), [session]);
  }
}

function formatSessionName(isoDate: string): string {
  const date = new Date(isoDate);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${month}月${day}日 ${hours}:${minutes}`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
