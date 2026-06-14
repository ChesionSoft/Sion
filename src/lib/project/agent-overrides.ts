import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { loadAgentRule } from "./agents";
import { isWorkflowNodeId } from "./nodes";
import type { AgentOverrideSetting, AgentRuleMode, WorkflowNodeId } from "./types";

export class AgentOverrideStore {
  constructor(private readonly rootDir = path.join(process.cwd(), "projects")) {}

  private overridesDir(projectId: string): string {
    return path.join(this.rootDir, projectId, "agent-overrides");
  }

  private indexPath(projectId: string): string {
    return path.join(this.overridesDir(projectId), "index.json");
  }

  private customRulePath(projectId: string, nodeId: WorkflowNodeId): string {
    return path.join(this.overridesDir(projectId), `${nodeId}.md`);
  }

  async listOverrides(projectId: string): Promise<AgentOverrideSetting[]> {
    try {
      return await readJson<AgentOverrideSetting[]>(this.indexPath(projectId));
    } catch {
      return [];
    }
  }

  async getOverride(projectId: string, nodeId: string): Promise<{
    setting: AgentOverrideSetting;
    defaultContent: string;
    customContent: string | null;
  }> {
    if (!isWorkflowNodeId(nodeId)) {
      throw new Error(`Unknown workflow node: ${nodeId}`);
    }

    const defaultRule = await loadAgentRule(nodeId);
    const overrides = await this.listOverrides(projectId);
    const existing = overrides.find((o) => o.nodeId === nodeId);

    const setting: AgentOverrideSetting = existing ?? {
      nodeId,
      mode: "default",
      updatedAt: new Date().toISOString(),
    };

    let customContent: string | null = null;
    if (setting.mode === "custom" && setting.customRulePath) {
      try {
        customContent = await readFile(
          path.join(this.overridesDir(projectId), setting.customRulePath),
          "utf8",
        );
      } catch {
        customContent = null;
      }
    }

    return {
      setting,
      defaultContent: defaultRule.content,
      customContent,
    };
  }

  async setMode(
    projectId: string,
    nodeId: string,
    mode: AgentRuleMode,
  ): Promise<AgentOverrideSetting> {
    if (!isWorkflowNodeId(nodeId)) {
      throw new Error(`Unknown workflow node: ${nodeId}`);
    }

    await mkdir(this.overridesDir(projectId), { recursive: true });
    const overrides = await this.listOverrides(projectId);
    const existing = overrides.find((o) => o.nodeId === nodeId);
    const now = new Date().toISOString();

    if (mode === "default") {
      if (existing?.customRulePath) {
        try {
          await unlink(path.join(this.overridesDir(projectId), existing.customRulePath));
        } catch {
          // file already gone
        }
      }

      const setting: AgentOverrideSetting = {
        nodeId,
        mode: "default",
        updatedAt: now,
      };

      if (existing) {
        const idx = overrides.findIndex((o) => o.nodeId === nodeId);
        overrides[idx] = setting;
      } else {
        overrides.push(setting);
      }

      await writeJson(this.indexPath(projectId), overrides);
      return setting;
    }

    // Switch to custom: copy default rule if no custom file exists
    const customFileName = `${nodeId}.md`;
    const customPath = this.customRulePath(projectId, nodeId);

    if (!existing || existing.mode === "default") {
      const defaultRule = await loadAgentRule(nodeId);
      await writeFile(customPath, defaultRule.content, "utf8");
    }

    const setting: AgentOverrideSetting = {
      nodeId,
      mode: "custom",
      customRulePath: customFileName,
      updatedAt: now,
    };

    if (existing) {
      const idx = overrides.findIndex((o) => o.nodeId === nodeId);
      overrides[idx] = setting;
    } else {
      overrides.push(setting);
    }

    await writeJson(this.indexPath(projectId), overrides);
    return setting;
  }

  async saveCustomContent(projectId: string, nodeId: string, content: string): Promise<AgentOverrideSetting> {
    if (!isWorkflowNodeId(nodeId)) {
      throw new Error(`Unknown workflow node: ${nodeId}`);
    }

    const overrides = await this.listOverrides(projectId);
    const existing = overrides.find((o) => o.nodeId === nodeId);

    if (!existing || existing.mode !== "custom") {
      throw new Error("请先将节点切换到自定义模式");
    }

    const customPath = this.customRulePath(projectId, nodeId);
    await writeFile(customPath, content, "utf8");

    const now = new Date().toISOString();
    existing.updatedAt = now;
    await writeJson(this.indexPath(projectId), overrides);

    return existing;
  }

  async resetToDefault(projectId: string, nodeId: string): Promise<AgentOverrideSetting> {
    if (!isWorkflowNodeId(nodeId)) {
      throw new Error(`Unknown workflow node: ${nodeId}`);
    }

    const overrides = await this.listOverrides(projectId);
    const existing = overrides.find((o) => o.nodeId === nodeId);

    if (!existing || existing.mode !== "custom") {
      throw new Error("节点不在自定义模式");
    }

    const defaultRule = await loadAgentRule(nodeId);
    const customPath = this.customRulePath(projectId, nodeId);
    await writeFile(customPath, defaultRule.content, "utf8");

    const now = new Date().toISOString();
    existing.updatedAt = now;
    await writeJson(this.indexPath(projectId), overrides);

    return existing;
  }

  async getActiveRuleContent(projectId: string, nodeId: string): Promise<string> {
    const { setting, defaultContent, customContent } = await this.getOverride(projectId, nodeId);

    if (setting.mode === "custom" && customContent) {
      return customContent;
    }

    return defaultContent;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
