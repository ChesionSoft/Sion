import { useMemo, useState } from "react";
import { NODES, statusLabel, type NodeId, type NodeStatus } from "../../types";
import { Dialog, Field, StatusDot } from "../ui";

export function NodePickerDialog({
  open,
  statuses,
  onClose,
  onSelect,
}: {
  open: boolean;
  statuses: Partial<Record<NodeId, NodeStatus | "unavailable">>;
  onClose: () => void;
  onSelect: (nodeId: NodeId) => void;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return NODES.filter(([id, title]) => !normalized || id.includes(normalized) || title.toLocaleLowerCase("zh-CN").includes(normalized));
  }, [query]);

  return (
    <Dialog open={open} title="全部节点" description="打开一个节点，它会出现在当前项目下方。" size="medium" closeLabel="关闭节点选择" onClose={onClose}>
      <div className="node-picker">
        <Field label="搜索节点" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入节点名称" autoFocus />
        <div className="node-picker-list">
          {rows.map(([id, title], index) => {
            const status = statuses[id];
            const label = status === "unavailable" ? "状态不可用" : status ? statusLabel[status] : "正在读取";
            return (
              <button key={id} onClick={() => onSelect(id)} type="button">
                <span className="node-picker-index">{String(index + 1).padStart(2, "0")}</span>
                <span><strong>{title}</strong><small>{id}</small></span>
                <span className="node-picker-status"><StatusDot kind={status === "confirmed" ? "success" : status === "needs_confirmation" ? "warning" : status === "unavailable" ? "error" : "neutral"} /><small>{label}</small></span>
              </button>
            );
          })}
          {rows.length === 0 ? <p className="node-picker-empty">没有匹配的节点</p> : null}
        </div>
      </div>
    </Dialog>
  );
}
