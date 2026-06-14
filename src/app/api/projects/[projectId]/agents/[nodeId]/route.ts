import { NextResponse } from "next/server";
import { AgentOverrideStore } from "@/lib/project/agent-overrides";
import { ProjectStore } from "@/lib/project/store";

const agentStore = new AgentOverrideStore();
const projectStore = new ProjectStore();

export async function GET(_request: Request, context: { params: Promise<{ projectId: string; nodeId: string }> }) {
  const { projectId, nodeId } = await context.params;
  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  try {
    const result = await agentStore.getOverride(projectId, nodeId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown workflow node")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; nodeId: string }> }) {
  const { projectId, nodeId } = await context.params;
  const project = await projectStore.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const body = (await request.json()) as {
    mode?: "default" | "custom";
    content?: string;
    resetToDefault?: boolean;
  };

  try {
    if (body.resetToDefault) {
      await agentStore.resetToDefault(projectId, nodeId);
      const result = await agentStore.getOverride(projectId, nodeId);
      return NextResponse.json(result);
    }

    if (body.mode) {
      await agentStore.setMode(projectId, nodeId, body.mode);
      const result = await agentStore.getOverride(projectId, nodeId);
      return NextResponse.json(result);
    }

    if (body.content !== undefined) {
      const setting = await agentStore.saveCustomContent(projectId, nodeId, body.content);
      return NextResponse.json({ setting });
    }

    return NextResponse.json({ error: "请提供 mode、content 或 resetToDefault" }, { status: 400 });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith("Unknown workflow node")) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
