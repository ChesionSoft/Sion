import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDocxQa } from "./docx-qa";

type RunResult = { code: number; stdout: string; stderr: string };

/** A configurable fake runner that materializes the PNGs pdftoppm would produce. */
function fakeRunner(opts: {
  pngs?: string[];
  text?: string;
  sofficeCode?: number;
  pdftoppmCode?: number;
}): (cmd: string, args: string[]) => Promise<RunResult> {
  return async (cmd: string, args: string[]) => {
    if (cmd.endsWith("soffice")) {
      const code = opts.sofficeCode ?? 0;
      return { code, stdout: "", stderr: code === 127 ? "soffice: command not found" : "soffice render error" };
    }
    if (cmd.endsWith("pdftoppm")) {
      const code = opts.pdftoppmCode ?? 0;
      if (code !== 0) return { code, stdout: "", stderr: "pdftoppm failed" };
      const prefix = args[args.length - 1];
      const dir = path.dirname(prefix);
      for (const name of opts.pngs ?? []) {
        await writeFile(path.join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd.endsWith("pdftotext")) return { code: 0, stdout: opts.text ?? "已确认中文内容。", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("runDocxQa", () => {
  it("fails QA when LibreOffice is unavailable", async () => {
    const report = await runDocxQa("/tmp/a.docx", {
      run: async () => ({ code: 127, stdout: "", stderr: "soffice: command not found" }),
    });
    expect(report).toMatchObject({
      passed: false,
      issues: [expect.objectContaining({ code: "renderer_unavailable" })],
    });
  });

  it("requires at least one rendered page and checks every page", async () => {
    const report = await runDocxQa("/tmp/a.docx", { run: fakeRunner({ pngs: ["page-1.png", "page-2.png"] }) });
    expect(report).toMatchObject({ passed: true, pageCount: 2 });
  });

  it("fails when no pages are rendered", async () => {
    const report = await runDocxQa("/tmp/a.docx", { run: fakeRunner({ pngs: [] }) });
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "no_pages" })]);
  });

  it("fails when rendered pages contain no CJK text", async () => {
    const report = await runDocxQa("/tmp/a.docx", {
      run: fakeRunner({ pngs: ["page-1.png"], text: "latin only, no cjk here" }),
    });
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "missing_cjk_text" })]);
  });

  it("fails when soffice reports a non-zero render error", async () => {
    const report = await runDocxQa("/tmp/a.docx", { run: fakeRunner({ sofficeCode: 1 }) });
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([expect.objectContaining({ code: "render_failed" })]);
  });
});