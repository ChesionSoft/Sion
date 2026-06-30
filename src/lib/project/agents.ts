import { readFile } from "node:fs/promises";
import path from "node:path";
import { getNodeDefinition } from "./nodes";
import type { WorkflowNodeId } from "./types";

export type AgentRule = {
  nodeId: WorkflowNodeId;
  filePath: string;
  content: string;
};

export type RenderAgentSystemPromptInput = {
  nodeId: WorkflowNodeId;
  projectName: string;
  currentMarkdown: string;
  contextMarkdown: string;
};

export async function loadAgentRule(nodeId: WorkflowNodeId): Promise<AgentRule> {
  const node = getNodeDefinition(nodeId);

  if (!node) {
    throw new Error(`Unknown workflow node: ${nodeId}`);
  }

  const filePath = path.join(process.cwd(), "agents", node.agentRuleFile);
  const content = await readFile(filePath, "utf8");

  return { nodeId, filePath, content };
}

export async function renderAgentSystemPrompt(input: RenderAgentSystemPromptInput): Promise<string> {
  const rule = await loadAgentRule(input.nodeId);

  return [
    `当前项目：${input.projectName}`,
    "",
    rule.content.trim(),
    "",
    "## 当前节点 Markdown",
    "",
    input.currentMarkdown.trim(),
    "",
    "## 可参考项目上下文",
    "",
    input.contextMarkdown.trim() || "暂无已确认上下文。",
    "",
    "## 回复要求",
    "",
    "- 先回答用户问题，再给出建议写入 Markdown 的内容。",
    "- 如果信息不足，每轮最多提出 3 个关键问题。",
    "- 分析或检索得到的内容直接写进对应正文小节，不要单独留“假设”小节。",
    "- 不确定、需要用户确认的问题只在聊天里追问，绝不写进交付稿。",
    "- 不要修改其他节点负责的章节。",
  ].join("\n");
}
