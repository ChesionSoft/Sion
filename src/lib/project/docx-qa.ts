import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Server-side DOCX render QA. The browser cannot be trusted as Word layout
 * QA, so the finalizer renders the DOCX to PDF via LibreOffice (`soffice`),
 * rasterizes each PDF page via poppler (`pdftoppm`), and inspects page
 * existence, non-zero image sizes, and extracted text for expected CJK
 * characters. `soffice`/`pdftoppm`/`pdftotext` are only ever invoked from this
 * server-only module.
 */

export type DocxQaIssueCode =
  | "renderer_unavailable"
  | "render_failed"
  | "no_pages"
  | "empty_page"
  | "missing_cjk_text";

export type DocxQaIssue = {
  code: DocxQaIssueCode;
  message: string;
  page?: number;
};

export type DocxQaReport = {
  passed: boolean;
  pageCount: number;
  issues: DocxQaIssue[];
  renderedAt: string;
};

export type DocxQaRunResult = { code: number; stdout: string; stderr: string };

export type DocxQaDeps = {
  /** Injected process runner (tests use fakes; default spawns the real tool). */
  run?: (cmd: string, args: string[]) => Promise<DocxQaRunResult>;
};

const NOW = (): string => new Date().toISOString();

export async function runDocxQa(docxPath: string, deps: DocxQaDeps = {}): Promise<DocxQaReport> {
  const run = deps.run ?? runProcess;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "sion-docx-qa-"));
  try {
    const profileDir = path.join(workDir, "lo-profile");
    const sofficeRes = await run("soffice", [
      "--headless",
      "--norestore",
      `-env:UserInstallation=file://${profileDir}`,
      "--convert-to",
      "pdf",
      "--outdir",
      workDir,
      docxPath,
    ]);
    if (sofficeRes.code === 127 || /command not found|not found|no such file/i.test(sofficeRes.stderr)) {
      return { passed: false, pageCount: 0, issues: [{ code: "renderer_unavailable", message: "LibreOffice (soffice) 不可用" }], renderedAt: NOW() };
    }
    if (sofficeRes.code !== 0) {
      return { passed: false, pageCount: 0, issues: [{ code: "render_failed", message: sofficeRes.stderr.trim() || "soffice 转换失败" }], renderedAt: NOW() };
    }

    const pdfPath = path.join(workDir, `${path.basename(docxPath, ".docx")}.pdf`);
    const prefix = path.join(workDir, "page");
    const pdftoppmRes = await run("pdftoppm", ["-png", "-r", "96", pdfPath, prefix]);
    if (pdftoppmRes.code === 127 || /command not found|not found/i.test(pdftoppmRes.stderr)) {
      return { passed: false, pageCount: 0, issues: [{ code: "renderer_unavailable", message: "poppler (pdftoppm) 不可用" }], renderedAt: NOW() };
    }
    if (pdftoppmRes.code !== 0) {
      return { passed: false, pageCount: 0, issues: [{ code: "render_failed", message: pdftoppmRes.stderr.trim() || "pdftoppm 渲染失败" }], renderedAt: NOW() };
    }

    const pngs = (await readdir(workDir))
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort((a, b) => pageNumber(a) - pageNumber(b));
    if (pngs.length === 0) {
      return { passed: false, pageCount: 0, issues: [{ code: "no_pages", message: "未渲染出任何页面" }], renderedAt: NOW() };
    }

    const issues: DocxQaIssue[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const page = i + 1;
      const info = await stat(path.join(workDir, pngs[i]));
      if (info.size === 0) {
        issues.push({ code: "empty_page", page, message: `第 ${page} 页为空` });
        continue;
      }
      const textRes = await run("pdftotext", ["-f", String(page), "-l", String(page), pdfPath, "-"]);
      if (textRes.code !== 0) {
        issues.push({ code: "render_failed", page, message: `第 ${page} 页文本提取失败` });
        continue;
      }
      const text = textRes.stdout.trim();
      if (!text) {
        issues.push({ code: "empty_page", page, message: `第 ${page} 页为空` });
      } else if (!/[一-鿿]/.test(text)) {
        issues.push({ code: "missing_cjk_text", page, message: `第 ${page} 页未检出中文字符` });
      }
    }

    return { passed: issues.length === 0, pageCount: pngs.length, issues, renderedAt: NOW() };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function pageNumber(filename: string): number {
  return Number(filename.match(/-(\d+)\.png$/)?.[1] ?? 0);
}

function runProcess(cmd: string, args: string[]): Promise<DocxQaRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, { env: process.env });
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      // ENOENT (binary not installed) is treated as renderer unavailable.
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
