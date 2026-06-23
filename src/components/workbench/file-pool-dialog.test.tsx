import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePoolDialog } from "./file-pool-dialog";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FilePoolDialog", () => {
  it("shows project asset types, extraction states, and metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      files: [
        {
          id: "pdf-1",
          originalName: "需求.pdf",
          storedName: "pdf-1.pdf",
          extension: ".pdf",
          mimeType: "application/pdf",
          byteSize: 2048,
          uploadedAt: "2026-06-23T10:00:00.000Z",
          status: "available",
          kind: "pdf",
          extractionStatus: "available",
          textPath: "pdf-1.txt",
          characterCount: 1200,
          pageCount: 3,
        },
        {
          id: "doc-1",
          originalName: "旧文档.doc",
          storedName: "doc-1.doc",
          extension: ".doc",
          mimeType: "application/msword",
          byteSize: 1024,
          uploadedAt: "2026-06-23T10:00:00.000Z",
          status: "unsupported",
          kind: "unsupported",
          extractionStatus: "unsupported",
          extractionError: "暂不支持该文件格式",
        },
      ],
    }))) as unknown as typeof fetch);

    render(<FilePoolDialog open onClose={() => {}} projectId="p-1" />);

    expect(await screen.findByText("上传项目资料")).toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText("可引用")).toBeInTheDocument();
    expect(screen.getByText(/3 页/)).toBeInTheDocument();
    expect(screen.getByText(/1,200 字符/)).toBeInTheDocument();
    expect(screen.getByText("暂不支持")).toBeInTheDocument();
    expect(screen.getByText("暂不支持该文件格式")).toBeInTheDocument();
  });

  it("accepts the phase-two project asset extensions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ files: [] }))) as unknown as typeof fetch);
    render(<FilePoolDialog open onClose={() => {}} projectId="p-1" />);

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    expect(input.accept).toContain(".pdf");
    expect(input.accept).toContain(".docx");
    expect(input.accept).toContain(".xlsx");
    expect(input.accept).toContain(".xls");
    expect(input.accept).toContain(".csv");
  });
});