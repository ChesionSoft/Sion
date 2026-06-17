import path from "node:path";

export class ProjectIdError extends Error {
  constructor(message = "Invalid project id") {
    super(message);
    this.name = "ProjectIdError";
  }
}

/**
 * Reject project ids that could escape the projects root via path separators,
 * traversal segments, or absolute paths. Real project ids are randomUUID()
 * output; the looser check keeps the existing human-readable test ids valid
 * while blocking every traversal vector (including %2F-decoded slashes).
 */
export function assertSafeProjectId(projectId: string): void {
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    path.isAbsolute(projectId)
  ) {
    throw new ProjectIdError();
  }
}