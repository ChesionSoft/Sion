import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

// mammoth is dynamically imported inside the route; mock it so the docx test
// does not need a real .docx binary.
vi.mock("mammoth", () => ({
  convertToHtml: vi.fn(async () => ({ value: "<h1>hi</h1>", messages: [] })),
}));

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-export-file-"));
  process.cwd = () => tmpDir;
  const projectsDir = path.join(tmpDir, "projects", "test-project");
  await mkdir(path.join(projectsDir, "exports"), { recursive: true });
  await writeFile(
    path.join(projectsDir, "project.json"),
    JSON.stringify(
      { id: "test-project", name: "T", createdAt: "2026-06-14T10:00:00.000Z", updatedAt: "2026-06-14T10:00:00.000Z" },
      null,
      2,
    ),
    "utf8",
  );
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

function req(filename: string, query = ""): Request {
  return new Request(
    `http://localhost/api/projects/test-project/exports/${encodeURIComponent(filename)}${query}`,
  );
}

function ctx(filename: string) {
  return { params: Promise.resolve({ projectId: "test-project", filename }) };
}

describe("GET /exports/[filename]", () => {
  it("serves a markdown file as text/markdown", async () => {
    await writeFile(
      path.join(tmpDir, "projects", "test-project", "exports", "PROJECT_DESIGN.md"),
      "# 设计",
      "utf8",
    );
    const res = await GET(req("PROJECT_DESIGN.md"), ctx("PROJECT_DESIGN.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# 设计");
  });

  it("sets attachment Content-Disposition with ?download=1", async () => {
    await writeFile(
      path.join(tmpDir, "projects", "test-project", "exports", "SPEC.md"),
      "spec",
      "utf8",
    );
    const res = await GET(req("SPEC.md", "?download=1"), ctx("SPEC.md"));
    expect(res.status).toBe(200);
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain("SPEC.md");
  });

  it("returns 404 for an unknown filename", async () => {
    const res = await GET(req("foo.md"), ctx("foo.md"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a traversal filename", async () => {
    const res = await GET(req("../project.json"), ctx("../project.json"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the file has not been generated", async () => {
    const res = await GET(req("TASKS.md"), ctx("TASKS.md"));
    expect(res.status).toBe(404);
  });

  it("returns 400 when ?as=html is requested for a markdown file", async () => {
    await writeFile(
      path.join(tmpDir, "projects", "test-project", "exports", "SPEC.md"),
      "spec",
      "utf8",
    );
    const res = await GET(req("SPEC.md", "?as=html"), ctx("SPEC.md"));
    expect(res.status).toBe(400);
  });

  it("converts docx to html with ?as=html", async () => {
    await writeFile(
      path.join(tmpDir, "projects", "test-project", "exports", "项目开发设计文档.docx"),
      "PK",
      "utf8",
    );
    const res = await GET(req("项目开发设计文档.docx", "?as=html"), ctx("项目开发设计文档.docx"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.html).toBe("<h1>hi</h1>");
  });
});
