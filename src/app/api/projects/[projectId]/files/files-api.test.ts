import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "@/lib/project/store";
import { POST } from "./route";

let tmpDir: string;
const originalCwd = process.cwd;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "Sion-files-api-"));
  process.cwd = () => tmpDir;
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("files API POST", () => {
  it("rejects uploads larger than 20 MB", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-23T00:00:00.000Z" });
    const oversized = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "huge.pdf", {
      type: "application/pdf",
    });
    const form = new FormData();
    form.append("file", oversized);

    // Build a Request-like object whose formData() returns the FormData
    // directly. Routing it through `new Request({ body: form })` would let
    // undici re-serialize the jsdom FormData and lose the filename/size, so
    // we bypass serialization — the route only calls request.formData().
    const fakeRequest = { formData: async () => form } as unknown as Request;

    const response = await POST(
      fakeRequest,
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "文件不能超过 20 MB" });
  });

  it("returns a rich extracted record for a readable upload", async () => {
    const store = new ProjectStore();
    const project = await store.createProject({ name: "CRM", now: "2026-06-23T00:00:00.000Z" });
    const upload = new File([Buffer.from("# 需求\n\n- 登录", "utf8")], "requirements.md", {
      type: "text/markdown",
    });
    const form = new FormData();
    form.append("file", upload);
    const fakeRequest = { formData: async () => form } as unknown as Request;

    const response = await POST(
      fakeRequest,
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(201);
    const data = (await response.json()) as { file: { status: string; kind: string; extractionStatus: string; characterCount: number; textPath: string } };
    expect(data.file).toMatchObject({
      status: "available",
      kind: "markdown",
      extractionStatus: "available",
      characterCount: 10,
    });
    expect(data.file.textPath).toMatch(/\.txt$/);
  });
});