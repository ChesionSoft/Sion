"use client";

import { useEffect, useState } from "react";
import { CheckIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { BrowserSearchPreferences, BrowserSearchStatus, SearchEngineId } from "@/lib/project/types";

type BrowserSearchSnapshot = {
  preferences: BrowserSearchPreferences;
  status: BrowserSearchStatus;
};

const DEFAULT_SNAPSHOT: BrowserSearchSnapshot = {
  preferences: { defaultEngine: "google", browserPreference: "system" },
  status: {
    systemBrowser: null,
    managedChromiumInstalled: false,
    profileConfigured: false,
  },
};

type BrowserAction = "detect" | "install" | "remove" | "clear_profile";

export function BrowserSearchConfigPanel() {
  const [snapshot, setSnapshot] = useState<BrowserSearchSnapshot>(DEFAULT_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mutation, setMutation] = useState<BrowserAction | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadSnapshot() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings/browser-search");
      const data = (await res.json()) as Partial<BrowserSearchSnapshot> & { error?: string };
      if (!res.ok || !data.preferences || !data.status) {
        setError(data.error ?? "读取浏览器搜索配置失败");
        return;
      }
      setSnapshot({ preferences: data.preferences, status: data.status });
    } catch {
      setError("读取浏览器搜索配置失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadSnapshot();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function updatePreferences(patch: Partial<BrowserSearchPreferences>) {
    const previous = snapshot;
    const nextPreferences = { ...snapshot.preferences, ...patch };
    setSnapshot((current) => ({ ...current, preferences: nextPreferences }));
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/settings/browser-search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextPreferences),
      });
      const data = (await res.json()) as Partial<BrowserSearchSnapshot> & { error?: string };
      if (!res.ok || !data.preferences || !data.status) {
        setSnapshot(previous);
        setError(data.error ?? "保存浏览器搜索配置失败");
        return;
      }
      setSnapshot({ preferences: data.preferences, status: data.status });
      setMessage("已保存浏览器搜索配置");
    } catch {
      setSnapshot(previous);
      setError("保存浏览器搜索配置失败");
    } finally {
      setSaving(false);
    }
  }

  async function runBrowserAction(action: BrowserAction) {
    if (action === "install" && !confirmInstall) {
      setConfirmInstall(true);
      setMessage("再次点击确认安装托管 Chromium。可选 Chromium 体积约 150-200MB，不属于应用依赖。");
      return;
    }

    setMutation(action);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/settings/browser-search/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as { status?: BrowserSearchStatus; error?: string };
      if (!res.ok || !data.status) {
        setError(data.error ?? "浏览器操作失败");
        return;
      }
      setSnapshot((current) => ({ ...current, status: data.status! }));
      setMessage(browserActionMessage(action));
      setConfirmInstall(false);
    } catch {
      setError("浏览器操作失败");
    } finally {
      setMutation(null);
    }
  }

  const busy = loading || saving || mutation !== null;
  const status = snapshot.status;
  const browserLabel = status.systemBrowser
    ? `${status.systemBrowser.kind === "chrome" ? "Chrome" : "Edge"} ${status.systemBrowser.version}`
    : "未检测到系统 Chrome/Edge";

  return (
    <Card>
      <CardHeader>
        <CardTitle>浏览器搜索</CardTitle>
        <CardDescription>
          配置 Sion 内置浏览器搜索。搜索通过本地安全代理执行，不需要第三方搜索 API Key。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? <p className="text-sm text-muted-foreground">正在读取浏览器搜索配置...</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="browser-search-engine">默认搜索引擎</Label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              disabled={busy}
              id="browser-search-engine"
              onChange={(e) => void updatePreferences({ defaultEngine: e.target.value as SearchEngineId })}
              value={snapshot.preferences.defaultEngine}
            >
              <option value="google">Google</option>
              <option value="baidu">百度</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="browser-preference">浏览器偏好</Label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              disabled={busy}
              id="browser-preference"
              onChange={(e) =>
                void updatePreferences({
                  browserPreference: e.target.value as BrowserSearchPreferences["browserPreference"],
                })
              }
              value={snapshot.preferences.browserPreference}
            >
              <option value="system">优先系统 Chrome/Edge</option>
              <option value="chromium">优先托管 Chromium</option>
            </select>
          </div>
        </div>

        <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-sm md:grid-cols-3">
          <StatusItem label="系统浏览器" value={browserLabel} ok={Boolean(status.systemBrowser)} />
          <StatusItem
            label="托管 Chromium"
            value={status.managedChromiumInstalled ? "已安装" : "未安装"}
            ok={status.managedChromiumInstalled}
          />
          <StatusItem
            label="独立资料目录"
            value={status.profileConfigured ? "已配置独立资料目录" : "尚未创建"}
            ok={status.profileConfigured}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          可选 Chromium 体积约 150-200MB，安装在用户缓存目录；它不是应用依赖，也不会自动下载。
        </p>

        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void runBrowserAction("detect")} type="button" variant="outline">
            <RefreshCwIcon data-icon="inline-start" />
            {mutation === "detect" ? "检测中..." : "重新检测"}
          </Button>
          <Button disabled={busy} onClick={() => void runBrowserAction("install")} type="button" variant="outline">
            <CheckIcon data-icon="inline-start" />
            {mutation === "install"
              ? "安装中..."
              : confirmInstall
                ? "确认安装托管 Chromium"
                : "安装托管 Chromium"}
          </Button>
          <Button disabled={busy || !status.managedChromiumInstalled} onClick={() => void runBrowserAction("remove")} type="button" variant="outline">
            <Trash2Icon data-icon="inline-start" />
            {mutation === "remove" ? "移除中..." : "移除托管 Chromium"}
          </Button>
          <Button disabled={busy || !status.profileConfigured} onClick={() => void runBrowserAction("clear_profile")} type="button" variant="outline">
            <Trash2Icon data-icon="inline-start" />
            {mutation === "clear_profile" ? "清理中..." : "清理独立资料目录"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusItem({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <Badge variant={ok ? "secondary" : "outline"}>{ok ? "可用" : "未就绪"}</Badge>
        <span className="text-xs text-foreground">{value}</span>
      </span>
    </div>
  );
}

function browserActionMessage(action: BrowserAction): string {
  if (action === "detect") return "已重新检测浏览器状态";
  if (action === "install") return "托管 Chromium 操作已完成";
  if (action === "remove") return "已移除托管 Chromium";
  return "已清理独立资料目录";
}
