import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  blockedMarkdownUrl,
  markdownImageLabel,
} from "../../markdown-policy.ts";

export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={blockedMarkdownUrl}
        components={{
          a: ({ children }) => <span className="markdown-link-text">{children}</span>,
          img: ({ alt }) => (
            <span className="markdown-image-placeholder">
              {markdownImageLabel(alt)}
            </span>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
