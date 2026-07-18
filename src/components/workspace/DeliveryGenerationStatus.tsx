import type { DeliveryGeneration } from "../../types";

export type DeliveryGenerationStatusProps = {
  generation: DeliveryGeneration | null;
  candidateLength: number;
  onCancel: () => void;
};

export function DeliveryGenerationStatus({
  generation,
  candidateLength,
  onCancel,
}: DeliveryGenerationStatusProps) {
  if (!generation) return null;
  const running = generation.status === "running";
  const open = running || generation.status === "failed" || generation.status === "conflict";
  const summary = running
    ? "正在重新生成交付稿"
    : generation.status === "completed"
      ? "已重新生成交付稿"
      : generation.status === "cancelled"
        ? "已取消重新生成"
        : generation.status === "conflict"
          ? "交付稿版本已变化，未覆盖"
          : "重新生成失败";
  return (
    <details className="delivery-generation-status" open={open}>
      <summary>{summary}</summary>
      <div className="delivery-generation-detail">
        {running ? <p>已生成 {candidateLength} 字，完成后将替换当前交付稿。</p> : null}
        {generation.error ? <p>{generation.error}</p> : null}
        {running ? (
          <button type="button" className="delivery-generation-stop" onClick={onCancel}>
            停止
          </button>
        ) : null}
      </div>
    </details>
  );
}
