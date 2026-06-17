import { describe, expect, it } from "vitest";
import { assertSafeProjectId, ProjectIdError } from "./paths";

describe("assertSafeProjectId", () => {
  it("accepts a UUID", () => {
    expect(() => assertSafeProjectId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  it("accepts the human-readable ids used by the test suite", () => {
    expect(() => assertSafeProjectId("test-project")).not.toThrow();
    expect(() => assertSafeProjectId("p-1")).not.toThrow();
    expect(() => assertSafeProjectId("legacy-project")).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["dot", "."],
    ["double-dot", ".."],
    ["parent segment", "../x"],
    ["forward slash separator", "a/b"],
    ["backslash separator", "a\\b"],
    ["absolute posix", "/etc/passwd"],
    ["absolute windows drive", "C:\\windows"],
    ["traversal suffix", "proj/.."],
  ])("rejects %s (%s)", (_label, value) => {
    expect(() => assertSafeProjectId(value)).toThrow(ProjectIdError);
  });
});