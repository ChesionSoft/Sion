import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserVerificationStore } from "@/lib/project/browser-verification";

const mocks = {
  openVisibleVerification: vi.fn(
    async (opts: { resolveUrl: () => Promise<string> }): Promise<void> => {
      await opts.resolveUrl();
    },
  ),
};

vi.mock("@/lib/project/browser-manager", () => {
  class BrowserManager {
    openVisibleVerification = mocks.openVisibleVerification;
  }
  return { BrowserManager };
});

import { GET, POST } from "./[verificationId]/route";

function post(verificationId: string, body: unknown, projectId = "p-1") {
  return POST(
    new Request(`http://localhost/api/projects/${projectId}/chat/verifications/${verificationId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId, verificationId }) },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.openVisibleVerification.mockImplementation(
    async (opts: { resolveUrl: () => Promise<string> }): Promise<void> => {
      await opts.resolveUrl();
    },
  );
});

describe("browser verification API", () => {
  it("opens a valid challenge once without exposing or accepting the URL", async () => {
    const created = await browserVerificationStore.create({
      engine: "google",
      challengeUrl: "https://www.google.com/sorry/index",
      projectId: "p-1",
      sessionId: "s-1",
    });

    const response = await post(created.verificationId, {
      sessionId: "s-1",
      url: "https://attacker.example/",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain("google.com/sorry");
    expect(mocks.openVisibleVerification).toHaveBeenCalledTimes(1);

    const opts = mocks.openVisibleVerification.mock.calls[0][0] as { resolveUrl: () => Promise<string> };
    await expect(opts.resolveUrl()).rejects.toThrow();
  });

  it("rejects missing sessionId with 400", async () => {
    const response = await post("missing", {});
    expect(response.status).toBe(400);
    expect(mocks.openVisibleVerification).not.toHaveBeenCalled();
  });

  it("rejects invalid, used, and wrong-owner challenges", async () => {
    expect((await post("missing", { sessionId: "s-1" })).status).toBe(404);

    const created = await browserVerificationStore.create({
      engine: "baidu",
      challengeUrl: "https://www.baidu.com/verify",
      projectId: "p-1",
      sessionId: "s-1",
    });
    expect((await post(created.verificationId, { sessionId: "s-other" })).status).toBe(404);

    const ok = await post(created.verificationId, { sessionId: "s-1" });
    expect(ok.status).toBe(200);
    expect((await post(created.verificationId, { sessionId: "s-1" })).status).toBe(404);
  });

  it("does not implement GET", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
  });
});
