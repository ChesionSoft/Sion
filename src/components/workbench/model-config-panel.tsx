"use client";

import { useEffect, useState } from "react";
import { PlusIcon, Trash2Icon, Edit3Icon, CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { ModelProvider } from "@/lib/project/types";

export function ModelConfigPanel() {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [error, setError] = useState("");
  const [editingProvider, setEditingProvider] = useState<ModelProvider | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);

  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    try {
      const res = await fetch("/api/settings/model-providers");
      const data = (await res.json()) as { providers: ModelProvider[] };
      setProviders(data.providers);
    } catch {
      setError("读取模型配置失败");
    }
  }

  async function saveProvider(provider: ModelProvider) {
    setError("");
    const res = await fetch(`/api/settings/model-providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(provider),
    });
    const data = (await res.json()) as { provider?: ModelProvider; error?: string };
    if (!res.ok || !data.provider) {
      setError(data.error ?? "保存失败");
      return;
    }
    await loadProviders();
    setEditingProvider(null);
  }

  async function createProvider(input: {
    name: string;
    apiBaseUrl: string;
    apiKey: string;
    models: string[];
    defaultModel: string;
  }) {
    setError("");
    const res = await fetch("/api/settings/model-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as { provider?: ModelProvider; error?: string };
    if (!res.ok || !data.provider) {
      setError(data.error ?? "创建失败");
      return;
    }
    await loadProviders();
    setShowAddDialog(false);
  }

  async function deleteProvider(providerId: string) {
    setError("");
    const res = await fetch(`/api/settings/model-providers/${providerId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      setError(data.error ?? "删除失败");
      return;
    }
    await loadProviders();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型配置</CardTitle>
        <CardDescription>管理全局大模型 API 连接，所有项目共享使用。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无配置的模型提供商。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{provider.name}</span>
                    {provider.isDefault ? (
                      <Badge variant="secondary">默认</Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {provider.apiBaseUrl} · {provider.models.length} 个模型
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    onClick={() => setEditingProvider({ ...provider })}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Edit3Icon data-icon="inline-start" />
                    编辑
                  </Button>
                  <Button
                    onClick={() => deleteProvider(provider.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon data-icon="inline-start" />
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Button onClick={() => setShowAddDialog(true)} type="button" variant="outline">
          <PlusIcon data-icon="inline-start" />
          添加提供商
        </Button>

        <AddProviderDialog
          onClose={() => setShowAddDialog(false)}
          onSave={createProvider}
          open={showAddDialog}
        />

        {editingProvider ? (
          <EditProviderDialog
            onClose={() => setEditingProvider(null)}
            onSave={saveProvider}
            provider={editingProvider}
            setProvider={setEditingProvider}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function AddProviderDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (input: { name: string; apiBaseUrl: string; apiKey: string; models: string[]; defaultModel: string }) => void;
}) {
  const [name, setName] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [error, setError] = useState("");

  function handleSave() {
    setError("");
    const models = modelsText
      .split(/[\n,]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (!name.trim()) { setError("名称不能为空"); return; }
    if (!apiBaseUrl.trim()) { setError("API Base URL 不能为空"); return; }
    if (!apiKey.trim()) { setError("API Key 不能为空"); return; }
    if (!models.length) { setError("至少需要一个模型名称"); return; }
    onSave({ name, apiBaseUrl, apiKey, models, defaultModel: defaultModel || models[0] });
  }

  if (!open) return null;

  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加模型提供商</DialogTitle>
          <DialogDescription>配置 OpenAI 兼容的大模型 API 连接。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-name">名称</Label>
            <Input id="mp-name" onChange={(e) => setName(e.target.value)} value={name} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-url">API Base URL</Label>
            <Input id="mp-url" onChange={(e) => setApiBaseUrl(e.target.value)} value={apiBaseUrl} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-key">API Key</Label>
            <Input id="mp-key" onChange={(e) => setApiKey(e.target.value)} type="password" value={apiKey} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-models">模型列表（每行一个或用逗号分隔）</Label>
            <Input id="mp-models" onChange={(e) => setModelsText(e.target.value)} value={modelsText} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-default">默认模型</Label>
            <Input id="mp-default" onChange={(e) => setDefaultModel(e.target.value)} value={defaultModel} />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} type="button" variant="outline">
              <XIcon data-icon="inline-start" />
              取消
            </Button>
            <Button onClick={handleSave} type="button">
              <CheckIcon data-icon="inline-start" />
              保存配置
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditProviderDialog({
  provider,
  setProvider,
  onClose,
  onSave,
}: {
  provider: ModelProvider;
  setProvider: (p: ModelProvider) => void;
  onClose: () => void;
  onSave: (p: ModelProvider) => void;
}) {
  const [modelsText, setModelsText] = useState(provider.models.join(", "));
  const [error, setError] = useState("");

  function handleSave() {
    setError("");
    const models = modelsText
      .split(/[\n,]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (!models.length) { setError("至少需要一个模型名称"); return; }
    onSave({ ...provider, models, defaultModel: provider.defaultModel || models[0] });
  }

  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑 {provider.name}</DialogTitle>
          <DialogDescription>修改提供商配置和模型列表。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-name">名称</Label>
            <Input
              id="edit-name"
              onChange={(e) => setProvider({ ...provider, name: e.target.value })}
              value={provider.name}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-url">API Base URL</Label>
            <Input
              id="edit-url"
              onChange={(e) => setProvider({ ...provider, apiBaseUrl: e.target.value })}
              value={provider.apiBaseUrl}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-key">API Key</Label>
            <Input
              id="edit-key"
              onChange={(e) => setProvider({ ...provider, apiKey: e.target.value })}
              type="password"
              value={provider.apiKey}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-models">模型列表（每行一个或用逗号分隔）</Label>
            <Input
              id="edit-models"
              onChange={(e) => setModelsText(e.target.value)}
              value={modelsText}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-default">默认模型</Label>
            <Input
              id="edit-default"
              onChange={(e) => setProvider({ ...provider, defaultModel: e.target.value })}
              value={provider.defaultModel}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              checked={provider.isDefault}
              className="h-4 w-4"
              id="edit-is-default"
              onChange={(e) => setProvider({ ...provider, isDefault: e.target.checked })}
              type="checkbox"
            />
            <Label htmlFor="edit-is-default">设为全局默认提供商</Label>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} type="button" variant="outline">
              <XIcon data-icon="inline-start" />
              取消
            </Button>
            <Button onClick={handleSave} type="button">
              <CheckIcon data-icon="inline-start" />
              保存配置
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
