import type { DeliveryGeneration } from "../../types";

export type DeliveryGenerationStatusProps = {
  generation: DeliveryGeneration | null;
  candidateLength: number;
  onCancel: () => void;
};

function generationSummary(status: DeliveryGeneration["status"]) {
  switch (status) {
    case "queued": return "等待重新生成交付稿";
    case "running": return "正在重新生成交付稿";
    case "completed": return "已重新生成交付稿";
    case "cancelled": return "已取消重新生成";
    case "conflict": return "交付稿版本已变化，未覆盖";
    case "failed": return "重新生成失败";
  }
}

export function DeliveryGenerationStatus({
  generation,
  candidateLength,
  onCancel,
}: DeliveryGenerationStatusProps) {
  if (!generation) return null;
  const queued = generation.status === "queued";
  const running = generation.status === "running";
  const active = queued || running;
  const open = active || generation.status === "failed" || generation.status === "conflict";
  const summary = generationSummary(generation.status);
  return (
    <details className="delivery-generation-status" open={open}>
      <summary>{summary}</summary>
      <div className="delivery-generation-detail">
        {queued ? <p>等待可用的 Agent 执行槽。</p> : null}
        {running ? <p>已生成 {candidateLength} 字，完成后将替换当前交付稿。</p> : null}
        {generation.error ? <p>{generation.error}</p> : null}
        {active ? (
          <button type="button" className="delivery-generation-stop" onClick={onCancel}>
            停止
          </button>
        ) : null}
      </div>
    </details>
  );
}
