import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "./files";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "Sion-files-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("FileStore", () => {
  it("uploads a text file and marks it available", async () => {
    const store = new FileStore(rootDir);
    const record = await store.uploadFile("test-project", {
      name: "readme.md",
      buffer: Buffer.from("# Hello\n\nWorld", "utf8"),
      mimeType: "text/markdown",
    });

    expect(record.status).toBe("available");
    expect(record.originalName).toBe("readme.md");
    expect(record.characterCount).toBe(14);
  });

  it("marks binary files as unsupported", async () => {
    const store = new FileStore(rootDir);
    const record = await store.uploadFile("test-project", {
      name: "image.png",
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
    });

    expect(record.status).toBe("unsupported");
    expect(record.textPath).toBeUndefined();
  });

  it("lists uploaded files", async () => {
    const store = new FileStore(rootDir);
    await store.uploadFile("test-project", {
      name: "a.txt",
      buffer: Buffer.from("aaa", "utf8"),
    });
    await store.uploadFile("test-project", {
      name: "b.md",
      buffer: Buffer.from("bbb", "utf8"),
    });

    const files = await store.listFiles("test-project");
    expect(files).toHaveLength(2);
  });

  it("deletes a file and its stored content", async () => {
    const store = new FileStore(rootDir);
    const record = await store.uploadFile("test-project", {
      name: "notes.txt",
      buffer: Buffer.from("notes", "utf8"),
    });

    await store.deleteFile("test-project", record.id);
    const files = await store.listFiles("test-project");
    expect(files).toHaveLength(0);
  });

  it("reads file content for available text files", async () => {
    const store = new FileStore(rootDir);
    const record = await store.uploadFile("test-project", {
      name: "data.csv",
      buffer: Buffer.from("a,b,c\n1,2,3", "utf8"),
    });

    const content = await store.readFileContent("test-project", record.id);
    expect(content).toBe("a,b,c\n1,2,3");
  });

  it("returns null when reading unsupported file", async () => {
    const store = new FileStore(rootDir);
    const record = await store.uploadFile("test-project", {
      name: "photo.png",
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    const content = await store.readFileContent("test-project", record.id);
    expect(content).toBeNull();
  });
});
