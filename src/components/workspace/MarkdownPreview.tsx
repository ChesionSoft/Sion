import { SafeMarkdown } from "./SafeMarkdown";

export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-preview">
      <SafeMarkdown markdown={markdown} variant="document" />
    </div>
  );
}
