import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExportPanel } from "./export-panel";

describe("ExportPanel", () => {
  it("links to the export center", () => {
    render(<ExportPanel projectId="abc" />);
    const link = screen.getByRole("link", { name: /导出中心/ });
    expect(link).toHaveAttribute("href", "/projects/abc/exports");
  });
});
