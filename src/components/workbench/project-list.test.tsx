/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "./project-list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}));

vi.mock("./model-config-panel", () => ({
  ModelConfigPanel: () => <section>模型配置</section>,
}));

vi.mock("./browser-search-config-panel", () => ({
  BrowserSearchConfigPanel: () => <section>浏览器搜索</section>,
}));

const project = (id: number) => ({
  id: `p-${id}`,
  name: `项目 ${id}`,
  customerName: "客户",
  authorName: "团队",
  version: "V1.0",
  createdAt: "2026-06-14T10:00:00.000Z",
  updatedAt: "2026-06-14T10:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProjectList", () => {
  it("renders browser search settings in the compact landing layout", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ projects: [project(1)] }))) as typeof fetch;

    render(<ProjectList />);

    expect(await screen.findByText("浏览器搜索")).toBeInTheDocument();
    expect(screen.getByText("模型配置")).toBeInTheDocument();
  });

  it("renders browser search settings in the dashboard layout", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [1, 2, 3, 4, 5].map(project) })),
    ) as typeof fetch;

    render(<ProjectList />);

    expect(await screen.findByText("浏览器搜索")).toBeInTheDocument();
    expect(screen.getByText("模型配置")).toBeInTheDocument();
  });
});
