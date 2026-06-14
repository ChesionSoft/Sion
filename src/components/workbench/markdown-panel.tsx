"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectNode } from "@/lib/project/types";

export function MarkdownPanel({ node, onChange }: { node: ProjectNode; onChange: (markdown: string) => void }) {
  return (
    <section className="flex min-h-0 flex-col bg-background">
      <div className="border-b px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">Markdown 源文档</p>
        <h2 className="text-sm font-semibold">{node.id}</h2>
      </div>
      <Tabs className="min-h-0 flex-1 p-4" defaultValue="edit">
        <TabsList>
          <TabsTrigger value="edit">编辑</TabsTrigger>
          <TabsTrigger value="preview">预览</TabsTrigger>
        </TabsList>
        <TabsContent className="min-h-0" value="edit">
          <Textarea
            className="h-[calc(100vh-170px)] min-h-[540px] resize-none font-mono text-sm"
            onChange={(event) => onChange(event.target.value)}
            value={node.markdown}
          />
        </TabsContent>
        <TabsContent className="min-h-0" value="preview">
          <div className="h-[calc(100vh-170px)] min-h-[540px] overflow-auto rounded-lg border bg-muted/10 p-4 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.markdown}</ReactMarkdown>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
