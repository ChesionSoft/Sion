export const CONVERSATION_PRESETS = [
  "梳理本节已有信息",
  "列出待确认问题",
  "基于参考资料补充细节",
  "检查本节遗漏并提出改进建议",
] as const;

export function ConversationPresets(props: {
  disabled?: boolean;
  onSelect: (preset: (typeof CONVERSATION_PRESETS)[number]) => void;
}) {
  const { disabled = false, onSelect } = props;
  return (
    <div className="conversation-presets" aria-label="对话建议">
      {CONVERSATION_PRESETS.map((preset, index) => (
        <button key={preset} type="button" disabled={disabled} onClick={() => onSelect(preset)}>
          <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <strong>{preset}</strong>
          <i aria-hidden="true">↗</i>
        </button>
      ))}
    </div>
  );
}
