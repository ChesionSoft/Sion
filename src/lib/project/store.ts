import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDefaultProject, createDefaultProjectNodes } from "./defaults";
import { WORKFLOW_NODES, isWorkflowNodeId } from "./nodes";
import type { ChatMessage, Project, ProjectNode, WorkflowNodeId } from "./types";

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
      await writeJson(this.chatPath(id, node.id), []);
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

  async getChatMessages(projectId: string, nodeId: WorkflowNodeId): Promise<ChatMessage[]> {
    return readJson<ChatMessage[]>(this.chatPath(projectId, nodeId));
  }

  async appendChatMessage(projectId: string, nodeId: WorkflowNodeId, message: ChatMessage): Promise<ChatMessage[]> {
    const messages = await this.getChatMessages(projectId, nodeId);
    const next = [...messages, message];
    await writeJson(this.chatPath(projectId, nodeId), next);
    return next;
  }

  projectDir(projectId: string): string {
    return path.join(this.rootDir, projectId);
  }

  exportPath(projectId: string, filename: string): string {
    return path.join(this.projectDir(projectId), "exports", filename);
  }

  private nodePath(projectId: string, nodeId: WorkflowNodeId): string {
    return path.join(this.projectDir(projectId), "nodes", `${nodeId}.json`);
  }

  private chatPath(projectId: string, nodeId: WorkflowNodeId): string {
    return path.join(this.projectDir(projectId), "chat", `${nodeId}.json`);
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
