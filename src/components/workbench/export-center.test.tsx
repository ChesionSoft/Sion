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

type StageLike = {
  blueprintDigest?: string;
  blueprintApprovedDigest?: string;
  draftDigest?: string;
  draftApprovedDigest?: string;
  qaStatus?: "passed" | "failed";
  qaReport?: {
    passed: boolean;
    pageCount: number;
    issues: { code: string; message: string; page?: number }[];
    renderedAt: string;
  };
  updatedAt: string;
};

let currentStage: StageLike;
let currentFiles: ExportFileInfo[];
let posts: { operation: string; body: Record<string, unknown> }[];

const PROVIDERS = [
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
];

beforeEach(() => {
  currentStage = { updatedAt: "" };
  currentFiles = [];
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://localhost");
      if (u.pathname.endsWith("/api/settings/model-providers")) {
        return jsonResponse({ providers: PROVIDERS });
      }
      if (u.searchParams.get("as") === "html") {
        return jsonResponse({ html: "<h1>doc</h1>" });
      }
      if (u.pathname === "/api/projects/p/exports") {
        if (init?.method === "POST") {
          const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
          posts.push({ operation: body.operation as string, body });
          const op = body.operation as string;
          if (op === "blueprint") currentStage = { ...currentStage, blueprintDigest: "bp-d" };
          if (op === "approve_blueprint") currentStage = { ...currentStage, blueprintApprovedDigest: currentStage.blueprintDigest };
          if (op === "draft") currentStage = { ...currentStage, draftDigest: "dr-d", draftApprovedDigest: undefined, qaStatus: undefined, qaReport: undefined };
          if (op === "approve_draft") currentStage = { ...currentStage, draftApprovedDigest: currentStage.draftDigest };
          if (op === "finalize") {
            currentStage = { ...currentStage, qaStatus: "passed", qaReport: { passed: true, pageCount: 1, issues: [], renderedAt: "" } };
            currentFiles = [
              { filename: "项目开发设计文档.docx", size: 1000, mtime: 1000 },
              { filename: "formal-prd-qa-report.md", size: 50, mtime: 1000 },
            ];
          }
          return jsonResponse({ stage: currentStage, digest: "x" });
        }
        return jsonResponse({ files: currentFiles, stage: currentStage });
      }
      return new Response("# 设计正文", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("ExportCenter review gates", () => {
  it("does not offer Word generation before the draft is approved", async () => {
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /生成导出蓝图/ })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "确认正文并生成正式 Word" })).not.toBeInTheDocument();
  });

  it("posts the blueprint operation when generating the blueprint", async () => {
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);
    const button = await screen.findByRole("button", { name: /生成导出蓝图/ });
    await userEvent.click(button);
    await waitFor(() => expect(posts.some((p) => p.operation === "blueprint")).toBe(true));
    // after blueprint generation the primary action advances to approve-and-draft
    await waitFor(() => expect(screen.getByRole("button", { name: /确认蓝图并生成正文/ })).toBeInTheDocument());
  });

  it("approves the blueprint and generates the draft in sequence", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);
    const button = await screen.findByRole("button", { name: /确认蓝图并生成正文/ });
    await userEvent.click(button);
    await waitFor(() => expect(posts.some((p) => p.operation === "approve_blueprint")).toBe(true));
    await waitFor(() => expect(posts.some((p) => p.operation === "draft")).toBe(true));
    expect(posts.find((p) => p.operation === "approve_blueprint")?.body.artifactDigest).toBe("bp-d");
  });

  it("approves the draft and finalizes in sequence (no model in the body)", async () => {
    currentStage = {
      blueprintDigest: "bp-d",
      blueprintApprovedDigest: "bp-d",
      draftDigest: "dr-d",
      updatedAt: "",
    };
    currentFiles = [{ filename: "formal-prd-draft.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    const button = await screen.findByRole("button", { name: /确认正文并生成正式 Word/ });
    await userEvent.click(button);
    await waitFor(() => expect(posts.some((p) => p.operation === "approve_draft")).toBe(true));
    await waitFor(() => expect(posts.some((p) => p.operation === "finalize")).toBe(true));
    expect(posts.find((p) => p.operation === "approve_draft")?.body.artifactDigest).toBe("dr-d");
    expect(posts.find((p) => p.operation === "finalize")?.body.providerId).toBeUndefined();
  });

  it("shows a blocking QA failure instead of a download link", async () => {
    currentStage = {
      blueprintDigest: "bp-d",
      blueprintApprovedDigest: "bp-d",
      draftDigest: "dr-d",
      draftApprovedDigest: "dr-d",
      qaStatus: "failed",
      qaReport: {
        passed: false,
        pageCount: 2,
        issues: [{ code: "missing_cjk_text", message: "第 2 页中文缺失", page: 2 }],
        renderedAt: "",
      },
      updatedAt: "",
    };
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);
    expect(await screen.findByText(/第 2 页中文缺失/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /下载/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新生成正式正文/ })).toBeInTheDocument();
  });

  it("re-generates the draft instead of immediately re-finalizing after QA fails", async () => {
    currentStage = {
      blueprintDigest: "bp-d",
      blueprintApprovedDigest: "bp-d",
      draftDigest: "dr-d",
      draftApprovedDigest: "dr-d",
      qaStatus: "failed",
      qaReport: { passed: false, pageCount: 1, issues: [{ code: "empty_page", message: "空白页" }], renderedAt: "" },
      updatedAt: "",
    };
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);

    await userEvent.click(await screen.findByRole("button", { name: /重新生成正式正文/ }));

    await waitFor(() => expect(posts.some((p) => p.operation === "draft")).toBe(true));
    expect(posts.some((p) => p.operation === "finalize")).toBe(false);
  });

  it("offers the Word download after QA passes", async () => {
    currentStage = {
      blueprintDigest: "bp-d",
      blueprintApprovedDigest: "bp-d",
      draftDigest: "dr-d",
      draftApprovedDigest: "dr-d",
      qaStatus: "passed",
      qaReport: { passed: true, pageCount: 1, issues: [], renderedAt: "" },
      updatedAt: "",
    };
    currentFiles = [
      { filename: "项目开发设计文档.docx", size: 1000, mtime: 1000 },
      { filename: "formal-prd-qa-report.md", size: 50, mtime: 1000 },
    ];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    const link = await screen.findByRole("link", { name: /下载/ });
    expect(link).toHaveAttribute(
      "href",
      "/api/projects/p/exports/%E9%A1%B9%E7%9B%AE%E5%BC%80%E5%8F%91%E8%AE%BE%E8%AE%A1%E6%96%87%E6%A1%A3.docx?download=1",
    );
  });

  it("lists all export filenames in the sidebar", async () => {
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={[]} />);
    expect(screen.getByRole("button", { name: "export-blueprint.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AGENTS.md" })).toBeInTheDocument();
  });
});
