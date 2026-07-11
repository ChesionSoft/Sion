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

const REVISE_APPLIED = [
  { status: "applied" },
  { status: "skipped", reason: "未找到章节：不存在" },
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
          if (op === "edit_blueprint") {
            if (typeof body.markdown === "string" && body.markdown.includes("待确认")) {
              return jsonResponse({ error: "正文包含待确认" }, { status: 422 });
            }
            currentStage = {
              ...currentStage,
              blueprintDigest: "bp-ed",
              blueprintApprovedDigest: undefined,
              draftDigest: undefined,
              draftApprovedDigest: undefined,
              qaStatus: undefined,
            };
          }
          if (op === "edit_draft") {
            if (typeof body.markdown === "string" && body.markdown.includes("待确认")) {
              return jsonResponse({ error: "正文包含待确认" }, { status: 422 });
            }
            currentStage = {
              ...currentStage,
              draftDigest: "dr-ed",
              draftApprovedDigest: undefined,
              qaStatus: undefined,
            };
          }
          if (op === "revise_blueprint" || op === "revise_draft") {
            if (body.artifactDigest === "stale") {
              return jsonResponse({ error: "摘要不匹配,请重新加载" }, { status: 409 });
            }
            return jsonResponse({ stage: currentStage, applied: REVISE_APPLIED });
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

describe("ExportCenter manual editing", () => {
  it("shows an 编辑 button for the blueprint but not for PROJECT_DESIGN.md", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [
      { filename: "export-blueprint.md", size: 10, mtime: 1000 },
      { filename: "PROJECT_DESIGN.md", size: 10, mtime: 1000 },
    ];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    expect(await screen.findByRole("button", { name: "编辑" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "PROJECT_DESIGN.md" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument());
  });

  it("edits the blueprint markdown and saves", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [{ filename: "export-blueprint.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const textarea = await screen.findByRole("textbox", { name: "编辑正文" });
    expect(textarea).toHaveValue("# 设计正文");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "# 编辑后的蓝图");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(posts.some((p) => p.operation === "edit_blueprint")).toBe(true));
    expect(posts.find((p) => p.operation === "edit_blueprint")?.body.markdown).toBe("# 编辑后的蓝图");
    await screen.findByText(/已保存/);
  });

  it("cancel restores preview mode without a POST", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [{ filename: "export-blueprint.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByRole("textbox", { name: "编辑正文" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑正文" })).not.toBeInTheDocument());
    expect(posts.some((p) => p.operation === "edit_blueprint")).toBe(false);
  });

  it("keeps the editor open and shows the error on a 422 edit response", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [{ filename: "export-blueprint.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const textarea = screen.getByRole("textbox", { name: "编辑正文" });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "包含待确认的内容");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/正文包含待确认/);
    expect(screen.getByRole("textbox", { name: "编辑正文" })).toBeInTheDocument();
  });
});

describe("ExportCenter agent revision", () => {
  it("shows the revision request box, button, and model picker for a blueprint with a digest", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [{ filename: "export-blueprint.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    expect(await screen.findByRole("textbox", { name: "Agent 修订指令" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "让 Agent 修订" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /模型/ })).toBeInTheDocument();
  });

  it("hides revision controls for non-editable files and during editing", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [
      { filename: "export-blueprint.md", size: 10, mtime: 1000 },
      { filename: "PROJECT_DESIGN.md", size: 10, mtime: 1000 },
    ];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    await screen.findByRole("textbox", { name: "Agent 修订指令" });
    await userEvent.click(screen.getByRole("button", { name: "PROJECT_DESIGN.md" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Agent 修订指令" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "export-blueprint.md" }));
    await screen.findByRole("textbox", { name: "Agent 修订指令" });
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Agent 修订指令" })).not.toBeInTheDocument());
  });

  it("posts revise_blueprint with instruction, digest, provider, model, and reasoning effort", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [{ filename: "export-blueprint.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    const textarea = await screen.findByRole("textbox", { name: "Agent 修订指令" });
    await screen.findByRole("button", { name: /模型/ });
    await userEvent.type(textarea, "改一下执行摘要");
    const reviseButton = screen.getByRole("button", { name: "让 Agent 修订" });
    await waitFor(() => expect(reviseButton).toBeEnabled());
    await userEvent.click(reviseButton);
    await waitFor(() => expect(posts.some((p) => p.operation === "revise_blueprint")).toBe(true));
    const body = posts.find((p) => p.operation === "revise_blueprint")!.body;
    expect(body.instruction).toBe("改一下执行摘要");
    expect(body.artifactDigest).toBe("bp-d");
    expect(body.providerId).toBe("p1");
    expect(body.model).toBe("m1");
    expect(body.reasoningEffort).toBe("medium");
  });

  it("shows applied/skipped counts on a partial applied response", async () => {
    currentStage = { blueprintDigest: "bp-d", updatedAt: "" };
    currentFiles = [{ filename: "export-blueprint.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    const textarea = await screen.findByRole("textbox", { name: "Agent 修订指令" });
    await screen.findByRole("button", { name: /模型/ });
    await userEvent.type(textarea, "改一下");
    await userEvent.click(screen.getByRole("button", { name: "让 Agent 修订" }));
    expect(await screen.findByText(/已应用 1 条修订/)).toBeInTheDocument();
    expect(screen.getByText(/已跳过/)).toBeInTheDocument();
  });

  it("shows the stale message on a 409", async () => {
    currentStage = { blueprintDigest: "stale", updatedAt: "" };
    currentFiles = [{ filename: "export-blueprint.md", size: 10, mtime: 1000 }];
    render(<ExportCenter projectId="p" projectName="测试项目" initialFiles={currentFiles} />);
    const textarea = await screen.findByRole("textbox", { name: "Agent 修订指令" });
    await screen.findByRole("button", { name: /模型/ });
    await userEvent.type(textarea, "改一下");
    await userEvent.click(screen.getByRole("button", { name: "让 Agent 修订" }));
    expect(await screen.findByText(/摘要不匹配|重新加载/)).toBeInTheDocument();
  });
});
