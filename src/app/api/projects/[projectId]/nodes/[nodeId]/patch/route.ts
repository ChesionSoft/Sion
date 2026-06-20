import { NextResponse } from "next/server";
import { z } from "zod";
import { isWorkflowNodeId } from "@/lib/project/nodes";
import { NodeRevisionConflictError, ProjectStore } from "@/lib/project/store";
import {
  UnpatchableError,
  applyPatches,
  validateNodeMarkdownPatch,
} from "@/lib/project/node-markdown-patcher";
import type { NodeMarkdownPatch, WorkflowNodeId } from "@/lib/project/types";

const patchRequestBodySchema = z.object({
  patches: z.array(z.unknown()),
  expectedRevision: z.number().refine(Number.isFinite, { message: "expectedRevision 必须是有限数字" }),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; nodeId: string }> },
) {
  const { projectId, nodeId } = await context.params;
  const store = new ProjectStore();

  if (!isWorkflowNodeId(nodeId)) {
    return NextResponse.json({ error: "流程节点不存在" }, { status: 404 });
  }

  const project = await store.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  // Parse body
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体必须为 JSON" }, { status: 400 });
  }

  // Validate container shape with Zod
  const parsed = patchRequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const error = firstIssue
      ? firstIssue.path.length > 0
        ? `缺少或非法字段：${firstIssue.path.join(".")}`
        : firstIssue.message
      : "请求体格式非法";
    return NextResponse.json({ error }, { status: 400 });
  }
  const { patches: patchesRaw, expectedRevision } = parsed.data;

  // Read current node
  const nodes = await store.getProjectNodes(projectId);
  const currentNode = nodes.find((n) => n.id === nodeId);
  if (!currentNode) {
    return NextResponse.json({ error: "节点不存在" }, { status: 404 });
  }

  // Per-patch validation — reject whole request on any invalid patch
  const validatedPatches: unknown[] = [];
  for (let i = 0; i < patchesRaw.length; i++) {
    try {
      validatedPatches.push(
        validateNodeMarkdownPatch(nodeId as WorkflowNodeId, patchesRaw[i]),
      );
    } catch (error) {
      if (error instanceof UnpatchableError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }
  }

  // Re-read the latest node and attempt a replay CAS write.
  // Returns a Response (200 on success, 409 on second conflict, 422 on apply failure).
  async function replayOnce(): Promise<Response> {
    const latestNodes = await store.getProjectNodes(projectId);
    const latest = latestNodes.find((n) => n.id === nodeId);
    if (!latest) {
      return NextResponse.json({ error: "节点不存在" }, { status: 404 });
    }

    let candidate: string;
    try {
      candidate = applyPatches(
        nodeId as WorkflowNodeId,
        latest.markdown,
        validatedPatches as NodeMarkdownPatch[],
      ).markdown;
    } catch (error) {
      if (error instanceof UnpatchableError) {
        return NextResponse.json(
          { error: error.message, latestNode: latest },
          { status: 422 },
        );
      }
      throw error;
    }

    try {
      const updated = await store.updateProjectNodeIfRevision(
        projectId,
        nodeId as WorkflowNodeId,
        latest.revision,
        { markdown: candidate, status: "generated" },
      );
      return NextResponse.json({ node: updated, replayed: true });
    } catch (error) {
      if (error instanceof NodeRevisionConflictError) {
        return NextResponse.json(
          { error: "节点已被其他操作修改", latestNode: error.latestNode },
          { status: 409 },
        );
      }
      throw error;
    }
  }

  // Attempt the first CAS write.
  // Returns: a Response (success/error), or the sentinel string "CONFLICT"
  // to signal that a replay should be attempted.
  async function firstAttempt(
    baseMarkdown: string,
    casRevision: number,
  ): Promise<Response | "CONFLICT"> {
    let candidate: string;
    try {
      candidate = applyPatches(
        nodeId as WorkflowNodeId,
        baseMarkdown,
        validatedPatches as NodeMarkdownPatch[],
      ).markdown;
    } catch (error) {
      if (error instanceof UnpatchableError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }

    try {
      const updated = await store.updateProjectNodeIfRevision(
        projectId,
        nodeId as WorkflowNodeId,
        casRevision,
        { markdown: candidate, status: "generated" },
      );
      return NextResponse.json({
        node: updated,
        replayed: casRevision !== expectedRevision,
      });
    } catch (error) {
      if (error instanceof NodeRevisionConflictError) {
        return "CONFLICT";
      }
      throw error;
    }
  }

  // Determine first-attempt strategy based on revision match
  let firstResult: Response | "CONFLICT";

  if (currentNode.revision === expectedRevision) {
    // Revision matches: apply + CAS with expectedRevision
    firstResult = await firstAttempt(currentNode.markdown, expectedRevision);
  } else {
    // Revision already stale: treat as direct replay
    firstResult = await firstAttempt(currentNode.markdown, currentNode.revision);
  }

  if (firstResult !== "CONFLICT") return firstResult;

  // First CAS conflicted — re-read latest and replay once
  return replayOnce();
}