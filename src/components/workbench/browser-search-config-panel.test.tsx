import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSearchConfigPanel } from "./browser-search-config-panel";

const defaultSnapshot = {
  preferences: { defaultEngine: "google", browserPreference: "system" },
  status: {
    systemBrowser: { kind: "chrome", version: "120.0" },
    managedChromiumInstalled: false,
    profileConfigured: true,
  },
};

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/browser-search" && !init) {
      return new Response(JSON.stringify(defaultSnapshot));
    }
    if (url === "/api/settings/browser-search" && init?.method === "PATCH") {
      return new Response(
        JSON.stringify({
          preferences: JSON.parse(String(init.body)),
          status: defaultSnapshot.status,
        }),
      );
    }
    if (url === "/api/settings/browser-search/browser" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          status: {
            systemBrowser: { kind: "chrome", version: "120.0" },
            managedChromiumInstalled: true,
            profileConfigured: true,
          },
        }),
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrowserSearchConfigPanel", () => {
  it("loads preferences, status, and labels optional Chromium size separately", async () => {
    render(<BrowserSearchConfigPanel />);

    expect(await screen.findByText("浏览器搜索")).toBeInTheDocument();
    expect(screen.getByText("Chrome 120.0")).toBeInTheDocument();
    expect(screen.getByText("已配置独立资料目录")).toBeInTheDocument();
    expect(screen.getByText(/可选 Chromium 体积/)).toBeInTheDocument();
    expect(screen.getByLabelText("默认搜索引擎")).toHaveValue("google");
    expect(screen.getByLabelText("浏览器偏好")).toHaveValue("system");
  });

  it("persists preference changes", async () => {
    const user = userEvent.setup();
    render(<BrowserSearchConfigPanel />);

    await user.selectOptions(await screen.findByLabelText("默认搜索引擎"), "baidu");

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/browser-search",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ defaultEngine: "baidu", browserPreference: "system" }),
        }),
      );
    });
  });

  it("requires explicit confirmation before installing managed Chromium", async () => {
    const user = userEvent.setup();
    render(<BrowserSearchConfigPanel />);

    await user.click(await screen.findByRole("button", { name: "安装托管 Chromium" }));
    expect(screen.getByText(/再次点击确认安装/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/settings/browser-search/browser",
      expect.objectContaining({ method: "POST" }),
    );

    await user.click(screen.getByRole("button", { name: "确认安装托管 Chromium" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/settings/browser-search/browser",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "install" }),
        }),
      );
    });
  });

  it("shows sanitized mutation failures", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings/browser-search" && !init) {
        return new Response(JSON.stringify(defaultSnapshot));
      }
      if (url === "/api/settings/browser-search/browser" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "浏览器操作失败" }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;

    const user = userEvent.setup();
    render(<BrowserSearchConfigPanel />);

    await user.click(await screen.findByRole("button", { name: "重新检测" }));

    expect(await screen.findByText("浏览器操作失败")).toBeInTheDocument();
  });
});
