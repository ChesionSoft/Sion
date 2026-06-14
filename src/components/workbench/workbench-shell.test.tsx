import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkbenchShell } from "./workbench-shell";
import type { Project, ProjectNode } from "@/lib/project/types";

beforeAll(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ providers: [], files: [] }))) as typeof fetch;
});

const project: Project = {
  id: "p-1",
  name: "库存管理系统",
  customerName: "示例客户",
  authorName: "示例团队",
  version: "V1.0",
  createdAt: "2026-06-14T10:00:00.000Z",
  updatedAt: "2026-06-14T10:00:00.000Z",
};

const nodes: ProjectNode[] = [
  {
    id: "basic-info",
    status: "draft",
    markdown: "# 项目基本信息",
    assumptions: [],
    openQuestions: [],
    updatedAt: "2026-06-14T10:00:00.000Z",
  },
] as ProjectNode[];

describe("WorkbenchShell", () => {
  it("renders project name, workflow navigation, chat panel, and markdown panel", () => {
    render(<WorkbenchShell project={project} nodes={nodes} />);
    expect(screen.getByText("库存管理系统")).toBeInTheDocument();
    expect(screen.getByText("项目基本信息")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("和当前节点 Agent 讨论... (Cmd+Enter 发送)")).toBeInTheDocument();
    expect(screen.getByDisplayValue("# 项目基本信息")).toBeInTheDocument();
  });
});
