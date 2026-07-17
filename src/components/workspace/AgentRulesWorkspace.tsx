import type { EffectiveAgentRules } from "../../types";
import { Button, EmptyState } from "../ui";

type AgentRulesWorkspaceProps = {
  rules: EffectiveAgentRules | null;
  loading: boolean;
  saving: boolean;
  customDraft: string;
  onCustomDraft: (value: string) => void;
  onSave: () => void;
  onRetry: () => void;
};

export function AgentRulesWorkspace({ rules, loading, saving, customDraft, onCustomDraft, onSave, onRetry }: AgentRulesWorkspaceProps) {
  if (loading) {
    return (
      <section className="agent-rules-workspace">
        <div className="agent-rules-loading">正在读取 agent.md…</div>
      </section>
    );
  }
  if (!rules) {
    return (
      <section className="agent-rules-workspace">
        <EmptyState title="无法读取 agent.md" description="读取节点规则时出错，可以重试。" action={{ label: "重试", onClick: onRetry }} />
      </section>
    );
  }
  return (
    <section className="agent-rules-workspace">
      <section className="agent-rule-section" aria-label="内置规则">
        <h3>内置规则</h3>
        <pre>{rules.builtInMarkdown}</pre>
      </section>
      <section className="agent-rule-section" aria-label="自定义规则">
        <h3>自定义规则</h3>
        <textarea
          aria-label="自定义规则 Markdown 编辑器"
          className="workspace-rule-editor"
          spellCheck={false}
          value={customDraft}
          onChange={(event) => onCustomDraft(event.target.value)}
        />
        <div className="agent-rule-section-actions">
          <Button variant="primary" loading={saving} onClick={onSave}>保存自定义规则</Button>
        </div>
      </section>
      <section className="agent-rule-section" aria-label="生效规则">
        <h3>生效规则</h3>
        <pre>{rules.effectiveMarkdown}</pre>
      </section>
    </section>
  );
}
