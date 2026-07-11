import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCenter } from "./export-center";
import type { ExportFileInfo } from "@/lib/project/export-files";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://localhost");
      if (u.pathname.endsWith("/api/settings/model-providers")) {
        return jsonResponse({
          providers: [
            {
              id: "p1",
              name: "P",
              apiBaseUrl: "https://x",
              apiKey: "k",
              protocol: "chat_completions",
              models: [{ name: "m1", isDefault: true }],
              isDefault: true,
              createdAt: "",
              updatedAt: "",
            },
          ],
        });
      }
      if (u.searchParams.get("as") === "html") {
        return jsonResponse({ html: "<h1>doc</h1>" });
      }
      if (u.pathname.endsWith("/exports")) {
        // GET list or POST generate - both return a files payload.
        return jsonResponse({
          files: [{ filename: "PROJECT_DESIGN.md", size: 6, mtime: 1000 }],
        });
      }
      // Raw markdown file content.
      return new Response("# 设计正文", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("ExportCenter", () => {
  it("renders the file list and loads the markdown preview for the first file", async () => {
    const initial: ExportFileInfo[] = [{ filename: "PROJECT_DESIGN.md", size: 6, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={initial} />);
    // The filename appears in the sidebar list button (and the preview header);
    // target the list button specifically.
    expect(screen.getByRole("button", { name: "PROJECT_DESIGN.md" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("设计正文")).toBeInTheDocument());
  });

  it("shows the generate button in empty state when there are no files", async () => {
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);
    expect(screen.getByRole("button", { name: /生成交付文档/ })).toBeInTheDocument();
    // No file selected -> no download link.
    expect(screen.queryByRole("link", { name: /下载/ })).not.toBeInTheDocument();
  });

  it("posts to generate and refreshes the list on click", async () => {
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /生成交付文档/ })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: /生成交付文档/ }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining("/api/projects/p/exports"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("offers a download link for the selected file", async () => {
    const initial: ExportFileInfo[] = [{ filename: "PROJECT_DESIGN.md", size: 6, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={initial} />);
    const link = await screen.findByRole("link", { name: /下载/ });
    expect(link).toHaveAttribute(
      "href",
      "/api/projects/p/exports/PROJECT_DESIGN.md?download=1",
    );
  });
});
