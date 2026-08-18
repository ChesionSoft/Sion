import { NODES } from "./types.ts";
import type { HarnessExecutionPlan, HarnessExecutionRecord, HarnessExecutionTarget, HarnessPlanInvalidReason, NodeId } from "./types.ts";

export function executionPlanTargets(plan: HarnessExecutionPlan): HarnessExecutionTarget[] {
  return plan.targets?.length ? plan.targets : [{ nodeId: plan.nodeId, baseRevision: plan.baseRevision }];
}

export function executionPlanStatusLabel(plan: HarnessExecutionPlan): string {
  if (plan.status === "pending") return "等待确认";
  if (plan.status === "consumed") return "已确认执行";
  return "计划已失效";
}

export function executionInvalidReasonLabel(reason?: HarnessPlanInvalidReason): string {
  switch (reason) {
    case "expired": return "确认等待时间已过期";
    case "node_changed": return "当前节点内容已变化";
    case "session_deleted": return "所属会话已删除";
    case "cancelled": return "计划已取消";
    case "restarted": return "应用重启后不会自动重放计划";
    case "manual_edit": return "当前节点已有其他保存";
    case "target_changed": return "计划中的目标节点内容已变化";
    case "target_missing": return "计划中的目标节点已不存在";
    case "ambiguous_confirmation": return "上一条回复不是明确确认";
    default: return "计划不可用，请重新讨论修改内容";
  }
}

export function executionStatusLabel(record: HarnessExecutionRecord): string {
  switch (record.status) {
    case "running": return "正在执行已确认修改";
    case "completed": return "修改执行完成";
    case "failed": return "执行未完整完成";
    case "cancelled": return "执行已取消";
    case "interrupted": return "执行因应用退出而中断";
  }
}

export function executionNodeLabel(nodeId: NodeId): string {
  return NODES.find(([id]) => id === nodeId)?.[1] ?? nodeId;
}

export function executionTargetState(
  plan: HarnessExecutionPlan | undefined,
  record: HarnessExecutionRecord | undefined,
  nodeId: NodeId,
): "pending" | "saved" | "stopped" {
  if (record?.stoppedTarget === nodeId && !record.completedTargets?.includes(nodeId)) return "stopped";
  if (record?.completedTargets?.includes(nodeId) || record?.writes.some((write) => (write.nodeId ?? plan?.nodeId) === nodeId)) return "saved";
  return "pending";
}
