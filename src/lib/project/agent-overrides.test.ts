import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentOverrideStore } from "./agent-overrides";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "Sion-agents-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("AgentOverrideStore", () => {
  it("returns default mode and content for a node with no override", async () => {
    const store = new AgentOverrideStore(rootDir);
    const result = await store.getOverride("test-project", "feature-design");

    expect(result.setting.mode).toBe("default");
    expect(result.defaultContent).toContain("你只负责功能模块设计");
    expect(result.customContent).toBeNull();
  });

  it("switches to custom mode and copies default rule", async () => {
    const store = new AgentOverrideStore(rootDir);
    const setting = await store.setMode("test-project", "feature-design", "custom");

    expect(setting.mode).toBe("custom");
    expect(setting.customRulePath).toBe("feature-design.md");

    const result = await store.getOverride("test-project", "feature-design");
    expect(result.customContent).toContain("你只负责功能模块设计");
  });

  it("saves custom content", async () => {
    const store = new AgentOverrideStore(rootDir);
    await store.setMode("test-project", "feature-design", "custom");
    await store.saveCustomContent("test-project", "feature-design", "# Custom Rule\n\nBe concise.");

    const result = await store.getOverride("test-project", "feature-design");
    expect(result.customContent).toBe("# Custom Rule\n\nBe concise.");
  });

  it("switches back to default mode", async () => {
    const store = new AgentOverrideStore(rootDir);
    await store.setMode("test-project", "feature-design", "custom");
    await store.setMode("test-project", "feature-design", "default");

    const result = await store.getOverride("test-project", "feature-design");
    expect(result.setting.mode).toBe("default");
    expect(result.customContent).toBeNull();
  });

  it("resets custom content to default", async () => {
    const store = new AgentOverrideStore(rootDir);
    await store.setMode("test-project", "feature-design", "custom");
    await store.saveCustomContent("test-project", "feature-design", "# Modified");
    await store.resetToDefault("test-project", "feature-design");

    const result = await store.getOverride("test-project", "feature-design");
    expect(result.customContent).toContain("你只负责功能模块设计");
  });

  it("getActiveRuleContent returns custom when in custom mode", async () => {
    const store = new AgentOverrideStore(rootDir);
    await store.setMode("test-project", "feature-design", "custom");
    await store.saveCustomContent("test-project", "feature-design", "# Custom");

    const content = await store.getActiveRuleContent("test-project", "feature-design");
    expect(content).toBe("# Custom");
  });

  it("getActiveRuleContent returns default when in default mode", async () => {
    const store = new AgentOverrideStore(rootDir);
    const content = await store.getActiveRuleContent("test-project", "feature-design");
    expect(content).toContain("你只负责功能模块设计");
  });
});
