import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSearchStore, ValidationError } from "./browser-search";
import type { BrowserSearchStatus } from "@/lib/project/types";

let settingsDir: string;

beforeEach(async () => {
  settingsDir = await mkdtemp(path.join(os.tmpdir(), "Sion-browser-search-"));
});

afterEach(async () => {
  await rm(settingsDir, { recursive: true, force: true });
});

const fakeStatus: BrowserSearchStatus = {
  systemBrowser: { kind: "chrome", version: "120.0" },
  managedChromiumInstalled: false,
  profileConfigured: false,
};

describe("BrowserSearchStore", () => {
  it("returns default preferences when no file exists", async () => {
    const store = new BrowserSearchStore(settingsDir, () => fakeStatus);
    const prefs = await store.getPreferences();
    expect(prefs).toEqual({ defaultEngine: "google", browserPreference: "system" });
  });

  it("getSnapshot returns preferences and derived status", async () => {
    const statusProvider = vi.fn(async () => fakeStatus);
    const store = new BrowserSearchStore(settingsDir, statusProvider);
    const snapshot = await store.getSnapshot();
    expect(snapshot.preferences).toEqual({ defaultEngine: "google", browserPreference: "system" });
    expect(snapshot.status).toEqual(fakeStatus);
    expect(statusProvider).toHaveBeenCalled();
  });

  it("persists a valid partial update atomically and returns merged preferences", async () => {
    const store = new BrowserSearchStore(settingsDir, () => fakeStatus);
    const merged = await store.updatePreferences({ defaultEngine: "baidu" });
    expect(merged).toEqual({ defaultEngine: "baidu", browserPreference: "system" });

    const reread = await store.getPreferences();
    expect(reread).toEqual(merged);
  });

  it("rejects an invalid engine enum", async () => {
    const store = new BrowserSearchStore(settingsDir, () => fakeStatus);
    await expect(
      store.updatePreferences({ defaultEngine: "bing" as never }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an invalid browser preference enum", async () => {
    const store = new BrowserSearchStore(settingsDir, () => fakeStatus);
    await expect(
      store.updatePreferences({ browserPreference: "firefox" as never }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects unknown fields", async () => {
    const store = new BrowserSearchStore(settingsDir, () => fakeStatus);
    await expect(
      store.updatePreferences({ extra: true } as unknown as { defaultEngine: "google" }),
    ).rejects.toThrow(ValidationError);
  });

  it("falls back to defaults on corrupt JSON without exposing the path", async () => {
    await writeFile(path.join(settingsDir, "browser-search.json"), "{ not valid json", "utf8");
    const store = new BrowserSearchStore(settingsDir, () => fakeStatus);
    const prefs = await store.getPreferences();
    expect(prefs).toEqual({ defaultEngine: "google", browserPreference: "system" });
  });

  it("falls back to defaults when stored shape is wrong", async () => {
    await writeFile(
      path.join(settingsDir, "browser-search.json"),
      JSON.stringify({ defaultEngine: "yahoo", browserPreference: "system" }),
      "utf8",
    );
    const store = new BrowserSearchStore(settingsDir, () => fakeStatus);
    const prefs = await store.getPreferences();
    expect(prefs).toEqual({ defaultEngine: "google", browserPreference: "system" });
  });
});