import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeSidebar } from "./node-sidebar";
import type { ProjectNode, WorkflowNodeDefinition } from "@/lib/project/types";

const definitions: WorkflowNodeDefinition[] = [
  { id: "basic-info", order: 1, title: "项目基本信息", documentHeading: "基本信息", dependsOn: [], agentRuleFile: "01-basic-info.md", requiredForInitialization: false },
  { id: "goals", order: 2, title: "项目目标", documentHeading: "目标", dependsOn: ["basic-info"], agentRuleFile: "02-goals.md", requiredForInitialization: false },
];

const nodes: ProjectNode[] = [
  { id: "basic-info", status: "confirmed", markdown: "# x", revision: 0, updatedAt: "x" },
  { id: "goals", status: "not_started", markdown: "# y", revision: 0, updatedAt: "x" },
];

describe("NodeSidebar", () => {
  it("collapsed rail shows the order number and a status dot per node", () => {
    render(
      <NodeSidebar
        activeNodeId="basic-info"
        collapsed
        definitions={definitions}
        nodes={nodes}
        onSelect={() => {}}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByLabelText("项目基本信息")).toBeInTheDocument();
    const dots = document.querySelectorAll(".node-status-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0].getAttribute("data-status")).toBe("confirmed");
    expect(dots[1].getAttribute("data-status")).toBe("not_started");
  });

  it("collapsed header shows only the expand button", () => {
    render(
      <NodeSidebar
        activeNodeId="basic-info"
        collapsed
        definitions={definitions}
        nodes={nodes}
        onSelect={() => {}}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByLabelText("展开流程节点")).toBeInTheDocument();
    expect(screen.queryByText("流程节点")).not.toBeInTheDocument();
  });

  it("expanded mode still shows titles and status badges", () => {
    render(
      <NodeSidebar
        activeNodeId="basic-info"
        definitions={definitions}
        nodes={nodes}
        onSelect={() => {}}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("项目基本信息")).toBeInTheDocument();
    expect(screen.getByText("已确认")).toBeInTheDocument();
  });

  it("calls onSelect with the node id when a collapsed item is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <NodeSidebar
        activeNodeId="basic-info"
        collapsed
        definitions={definitions}
        nodes={nodes}
        onSelect={onSelect}
        onToggle={() => {}}
      />,
    );
    await user.click(screen.getByLabelText("项目基本信息"));
    expect(onSelect).toHaveBeenCalledWith("basic-info");
  });
});