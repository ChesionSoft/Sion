import { describe, expect, it } from "vitest";
import { BrowserVerificationStore } from "./browser-verification";
import type { SearchEngineId } from "./types";

function makeStore(opts: { now?: () => number; id?: () => string } = {}) {
  return new BrowserVerificationStore({
    now: opts.now ?? (() => 1_000_000),
    id: opts.id ?? (() => "verif-id"),
  });
}

describe("BrowserVerificationStore/create", () => {
  it("returns only verificationId and engine, never the challenge URL", async () => {
    const store = makeStore();
    const created = await store.create({
      engine: "google" as SearchEngineId,
      challengeUrl: "https://www.google.com/sorry?continue=secret",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    expect(created).toEqual({ verificationId: "verif-id", engine: "google" });
    expect(JSON.stringify(created)).not.toContain("sorry");
    expect(JSON.stringify(created)).not.toContain("challengeUrl");
  });
});

describe("BrowserVerificationStore/consume", () => {
  it("returns the challenge URL for the owning project/session", async () => {
    const store = makeStore();
    await store.create({
      engine: "baidu",
      challengeUrl: "https://www.baidu.com/verify?x=1",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    const url = await store.consume({ verificationId: "verif-id", projectId: "proj-1", sessionId: "sess-1" });
    expect(url).toBe("https://www.baidu.com/verify?x=1");
  });

  it("rejects a wrong project", async () => {
    const store = makeStore();
    await store.create({
      engine: "google",
      challengeUrl: "https://g/verify",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    expect(
      store.consume({ verificationId: "verif-id", projectId: "proj-other", sessionId: "sess-1" }),
    ).rejects.toBeDefined();
  });

  it("rejects a wrong session", async () => {
    const store = makeStore();
    await store.create({
      engine: "google",
      challengeUrl: "https://g/verify",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    expect(
      store.consume({ verificationId: "verif-id", projectId: "proj-1", sessionId: "sess-other" }),
    ).rejects.toBeDefined();
  });

  it("is single-use: a second consume fails", async () => {
    const store = makeStore();
    await store.create({
      engine: "google",
      challengeUrl: "https://g/verify",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    await store.consume({ verificationId: "verif-id", projectId: "proj-1", sessionId: "sess-1" });
    expect(
      store.consume({ verificationId: "verif-id", projectId: "proj-1", sessionId: "sess-1" }),
    ).rejects.toBeDefined();
  });

  it("rejects an unknown verification id", async () => {
    const store = makeStore();
    expect(
      store.consume({ verificationId: "missing", projectId: "proj-1", sessionId: "sess-1" }),
    ).rejects.toBeDefined();
  });
});

describe("BrowserVerificationStore/expiry", () => {
  it("rejects a challenge older than 10 minutes", async () => {
    let time = 1_000_000;
    const store = new BrowserVerificationStore({ now: () => time, id: () => "v1" });
    await store.create({
      engine: "google",
      challengeUrl: "https://g/verify",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    time += 11 * 60 * 1000; // 11 minutes later
    expect(
      store.consume({ verificationId: "v1", projectId: "proj-1", sessionId: "sess-1" }),
    ).rejects.toBeDefined();
  });

  it("accepts a challenge just under 10 minutes", async () => {
    let time = 1_000_000;
    const store = new BrowserVerificationStore({ now: () => time, id: () => "v1" });
    await store.create({
      engine: "google",
      challengeUrl: "https://g/verify",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    time += 9 * 60 * 1000 + 59_000;
    const url = await store.consume({ verificationId: "v1", projectId: "proj-1", sessionId: "sess-1" });
    expect(url).toBe("https://g/verify");
  });

  it("purges expired records on access", async () => {
    let time = 1_000_000;
    const store = new BrowserVerificationStore({ now: () => time, id: () => "v1" });
    await store.create({
      engine: "google",
      challengeUrl: "https://g/verify",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    time += 11 * 60 * 1000;
    // accessing (create or consume) should not throw and should drop expired
    await store.create({ engine: "google", challengeUrl: "https://g/2", projectId: "p", sessionId: "s" });
    expect(
      store.consume({ verificationId: "v1", projectId: "proj-1", sessionId: "sess-1" }),
    ).rejects.toBeDefined();
  });
});

describe("BrowserVerificationStore/delete and cap", () => {
  it("explicitly deletes a challenge", async () => {
    const store = makeStore();
    await store.create({
      engine: "google",
      challengeUrl: "https://g/verify",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    await store.delete("verif-id");
    expect(
      store.consume({ verificationId: "verif-id", projectId: "proj-1", sessionId: "sess-1" }),
    ).rejects.toBeDefined();
  });

  it("caps the number of stored entries", async () => {
    let counter = 0;
    const store = new BrowserVerificationStore({
      now: () => 1_000_000,
      id: () => `v${counter++}`,
      maxEntries: 3,
    });
    for (let i = 0; i < 5; i++) {
      await store.create({ engine: "google", challengeUrl: `https://g/${i}`, projectId: "p", sessionId: "s" });
    }
    // The oldest entries (v0, v1) should have been evicted; v2..v4 remain.
    expect(
      store.consume({ verificationId: "v0", projectId: "p", sessionId: "s" }),
    ).rejects.toBeDefined();
    const url = await store.consume({ verificationId: "v4", projectId: "p", sessionId: "s" });
    expect(url).toBe("https://g/4");
  });

  it("never exposes the challenge URL via any public accessor", async () => {
    const store = makeStore();
    const created = await store.create({
      engine: "google",
      challengeUrl: "https://secret.example/challenge",
      projectId: "p",
      sessionId: "s",
    });
    // Only verificationId + engine are public; the URL only comes out via consume.
    expect(Object.keys(created).sort()).toEqual(["engine", "verificationId"]);
  });
});