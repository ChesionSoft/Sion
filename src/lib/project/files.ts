import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { assertSafeProjectId } from "./paths";
import { extractFileText, isReadableProjectFile } from "./file-extraction";
import type { ProjectFile } from "./types";

export class FileStore {
  constructor(private readonly rootDir = path.join(process.cwd(), "projects")) {}

  private filesDir(projectId: string): string {
    assertSafeProjectId(projectId);
    return path.join(this.rootDir, projectId, "files");
  }

  private indexPath(projectId: string): string {
    return path.join(this.filesDir(projectId), "index.json");
  }

  async listFiles(projectId: string): Promise<ProjectFile[]> {
    try {
      return await readJson<ProjectFile[]>(this.indexPath(projectId));
    } catch {
      return [];
    }
  }

  async uploadFile(
    projectId: string,
    file: { name: string; buffer: Buffer; mimeType?: string },
  ): Promise<ProjectFile> {
    await mkdir(this.filesDir(projectId), { recursive: true });

    const ext = path.extname(file.name).toLowerCase();
    const id = randomUUID();
    const storedName = `${id}${ext}`;
    const storedPath = path.join(this.filesDir(projectId), storedName);

    await writeFile(storedPath, file.buffer);

    const extraction = await extractFileText({
      fileName: file.name,
      mimeType: file.mimeType,
      buffer: file.buffer,
    });
    const textStoredName = extraction.extractionStatus === "available" ? `${id}.txt` : undefined;

    if (textStoredName && extraction.text) {
      await writeFile(path.join(this.filesDir(projectId), textStoredName), extraction.text, "utf8");
    }

    const status: ProjectFile["status"] =
      extraction.extractionStatus === "available"
        ? "available"
        : extraction.extractionStatus === "unsupported"
          ? "unsupported"
          : "read_failed";

    const record: ProjectFile = {
      id,
      originalName: file.name,
      storedName,
      extension: ext,
      mimeType: file.mimeType ?? "application/octet-stream",
      byteSize: file.buffer.length,
      uploadedAt: new Date().toISOString(),
      status,
      textPath: textStoredName,
      characterCount: extraction.characterCount,
      kind: extraction.kind,
      extractionStatus: extraction.extractionStatus,
      extractionError: extraction.extractionError,
      pageCount: extraction.pageCount,
      sheetCount: extraction.sheetCount,
      truncated: extraction.truncated,
    };

    const files = await this.listFiles(projectId);
    files.push(record);
    await writeJson(this.indexPath(projectId), files);

    return record;
  }

  async deleteFile(projectId: string, fileId: string): Promise<void> {
    const files = await this.listFiles(projectId);
    const index = files.findIndex((f) => f.id === fileId);
    if (index === -1) throw new Error("文件不存在");

    const record = files[index];
    const storedPath = path.join(this.filesDir(projectId), record.storedName);

    try {
      await unlink(storedPath);
    } catch {
      // file already gone, continue
    }

    if (record.textPath && record.textPath !== record.storedName) {
      await unlink(path.join(this.filesDir(projectId), record.textPath)).catch(() => {
        // extracted text copy already gone, continue
      });
    }

    files.splice(index, 1);
    await writeJson(this.indexPath(projectId), files);
  }

  async getFile(projectId: string, fileId: string): Promise<ProjectFile | null> {
    const files = await this.listFiles(projectId);
    return files.find((f) => f.id === fileId) ?? null;
  }

  async readFileContent(projectId: string, fileId: string): Promise<string | null> {
    const record = await this.getFile(projectId, fileId);
    if (!record || !isReadableProjectFile(record) || !record.textPath) return null;

    try {
      return await readFile(path.join(this.filesDir(projectId), record.textPath), "utf8");
    } catch {
      return null;
    }
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
