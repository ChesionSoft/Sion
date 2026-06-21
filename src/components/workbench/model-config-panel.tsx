"use client";

import { useEffect, useState } from "react";
import { PlusIcon, Trash2Icon, Edit3Icon, CheckIcon, XIcon, StarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { ApiUrlMode, ContextLength, ModelEntry, ModelProvider, ModelProviderProtocol } from "@/lib/project/types";

const CONTEXT_LENGTH_OPTIONS: Array<{ value: ContextLength | undefined; label: string }> = [
  { value: undefined, label: "不填" },
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 200000, label: "200K" },
  { value: 1000000, label: "1M" },
];

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
    apiUrlMode: ApiUrlMode;
    protocol: ModelProviderProtocol;
    apiKey: string;
    models: ModelEntry[];
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
        <CardDescription>
          配置 OpenAI 兼容的大模型 API。全局提供商会作为默认连接，每个聊天框仍可选择具体模型和推理强度。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无模型提供商。添加后即可在项目节点聊天框中选择模型推进文档。
          </p>
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
                    {provider.protocol === "openai_responses" ? (
                      <Badge variant="outline">Responses</Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {provider.protocol === "openai_responses" ? "OpenAI Responses" : "Chat Completions"} &middot; {provider.apiUrlMode === "full" ? "完整 API 链接" : "系统填充"} &middot; {provider.apiBaseUrl} &middot; {provider.models.length} 个模型
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    onClick={() => setEditingProvider({ ...provider, models: provider.models.map((m) => ({ ...m })) })}
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
          添加模型提供商
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

function ModelEntryEditor({
  models,
  onChange,
}: {
  models: ModelEntry[];
  onChange: (models: ModelEntry[]) => void;
}) {
  function updateModel(index: number, patch: Partial<ModelEntry>) {
    const next = models.map((m, i) => (i === index ? { ...m, ...patch } : m));
    if (patch.isDefault) {
      next.forEach((m, i) => {
        m.isDefault = i === index;
      });
    }
    onChange(next);
  }

  function addModel() {
    onChange([...models, { name: "", isDefault: models.length === 0 }]);
  }

  function removeModel(index: number) {
    if (models.length <= 1) return;
    const next = models.filter((_, i) => i !== index);
    if (!next.some((m) => m.isDefault) && next.length > 0) {
      next[0].isDefault = true;
    }
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
        <Label>模型列表与上下文长度</Label>
      {models.map((model, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            className="flex-1"
            onChange={(e) => updateModel(index, { name: e.target.value })}
            placeholder="例如：gpt-4.1、deepseek-chat"
            value={model.name}
          />
          <select
            className="h-9 w-20 rounded-md border bg-background px-2 text-sm"
            onChange={(e) => {
              const val = e.target.value;
              updateModel(index, { contextLength: val ? (Number(val) as ContextLength) : undefined });
            }}
            value={model.contextLength ?? ""}
          >
            {CONTEXT_LENGTH_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ""}>
                {opt.label}
              </option>
            ))}
          </select>
          <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title="该模型是否支持函数工具调用（不支持则用规划器兜底）">
            <input
              aria-label={`工具调用：${model.name || `模型 ${index + 1}`}`}
              checked={!!model.toolCalling}
              onChange={(e) => updateModel(index, { toolCalling: e.target.checked })}
              type="checkbox"
              className="h-4 w-4"
            />
            工具
          </label>
          <button
            className={`shrink-0 rounded p-1 ${model.isDefault ? "text-amber-500" : "text-muted-foreground hover:text-amber-500"}`}
            onClick={() => updateModel(index, { isDefault: true })}
            title="设为默认模型"
            type="button"
          >
            <StarIcon className="h-4 w-4" fill={model.isDefault ? "currentColor" : "none"} />
          </button>
          <button
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
            disabled={models.length <= 1}
            onClick={() => removeModel(index)}
            title="删除模型"
            type="button"
          >
            <Trash2Icon className="h-4 w-4" />
          </button>
        </div>
      ))}
      <Button onClick={addModel} size="sm" type="button" variant="outline">
        <PlusIcon data-icon="inline-start" />
          添加一个模型
      </Button>
    </div>
  );
}

function AddProviderDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (input: { name: string; apiBaseUrl: string; apiUrlMode: ApiUrlMode; protocol: ModelProviderProtocol; apiKey: string; models: ModelEntry[] }) => void;
}) {
  const [name, setName] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiUrlMode, setApiUrlMode] = useState<ApiUrlMode>("base");
  const [protocol, setProtocol] = useState<ModelProviderProtocol>("chat_completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelEntry[]>([{ name: "", isDefault: true }]);
  const [error, setError] = useState("");

  function handleSave() {
    setError("");
    if (!name.trim()) { setError("名称不能为空"); return; }
    if (!apiBaseUrl.trim()) { setError("API Base URL 不能为空"); return; }
    if (!apiKey.trim()) { setError("API Key 不能为空"); return; }
    if (models.length === 0 || models.every((m) => !m.name.trim())) { setError("至少需要一个模型名称"); return; }
    if (models.some((m) => m.name.trim() === "")) { setError("模型名称不能为空"); return; }
    onSave({ name, apiBaseUrl, apiUrlMode, protocol, apiKey, models });
  }

  if (!open) return null;

  const baseUrlHint = apiUrlMode === "full"
    ? "系统会直接请求这个完整接口。"
    : protocol === "openai_responses"
      ? "系统会自动补全 /v1/responses。"
      : "系统会自动补全 /v1/chat/completions。";

  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加模型提供商</DialogTitle>
          <DialogDescription>
            填写服务商名称、API 链接、API Key，并登记可在聊天框中选择的模型。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-name">提供商名称</Label>
            <Input id="mp-name" onChange={(e) => setName(e.target.value)} value={name} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-protocol">API 协议</Label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              id="mp-protocol"
              onChange={(e) => setProtocol(e.target.value as ModelProviderProtocol)}
              value={protocol}
            >
              <option value="chat_completions">OpenAI-compatible Chat Completions</option>
              <option value="openai_responses">OpenAI Responses</option>
            </select>
            <p className="text-xs text-muted-foreground">
              协议仅决定请求格式，不决定是否支持联网；联网能力按模型单独设置。
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-url-mode">API 链接模式</Label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              id="mp-url-mode"
              onChange={(e) => setApiUrlMode(e.target.value as ApiUrlMode)}
              value={apiUrlMode}
            >
              <option value="base">系统填充</option>
              <option value="full">完整 API 链接</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-url">{apiUrlMode === "full" ? "完整 API URL" : "API Base URL"}</Label>
            <Input id="mp-url" onChange={(e) => setApiBaseUrl(e.target.value)} value={apiBaseUrl} />
            <p className="text-xs text-muted-foreground">
              {baseUrlHint}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mp-key">API Key</Label>
            <Input id="mp-key" onChange={(e) => setApiKey(e.target.value)} type="password" value={apiKey} />
          </div>
          <ModelEntryEditor models={models} onChange={setModels} />
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
  const [error, setError] = useState("");

  function handleSave() {
    setError("");
    if (!provider.models.length || provider.models.every((m) => !m.name.trim())) {
      setError("至少需要一个模型名称");
      return;
    }
    if (provider.models.some((m) => !m.name.trim())) {
      setError("模型名称不能为空");
      return;
    }
    onSave(provider);
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
            <Label htmlFor="edit-name">提供商名称</Label>
            <Input
              id="edit-name"
              onChange={(e) => setProvider({ ...provider, name: e.target.value })}
              value={provider.name}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-protocol">API 协议</Label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              id="edit-protocol"
              onChange={(e) => setProvider({ ...provider, protocol: e.target.value as ModelProviderProtocol })}
              value={provider.protocol ?? "chat_completions"}
            >
              <option value="chat_completions">OpenAI-compatible Chat Completions</option>
              <option value="openai_responses">OpenAI Responses</option>
            </select>
            <p className="text-xs text-muted-foreground">
              协议仅决定请求格式，不决定是否支持联网；联网能力按模型单独设置。
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-url-mode">API 链接模式</Label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              id="edit-url-mode"
              onChange={(e) => setProvider({ ...provider, apiUrlMode: e.target.value as ApiUrlMode })}
              value={provider.apiUrlMode ?? "base"}
            >
              <option value="base">系统填充</option>
              <option value="full">完整 API 链接</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-url">{provider.apiUrlMode === "full" ? "完整 API URL" : "API Base URL"}</Label>
            <Input
              id="edit-url"
              onChange={(e) => setProvider({ ...provider, apiBaseUrl: e.target.value })}
              value={provider.apiBaseUrl}
            />
            <p className="text-xs text-muted-foreground">
              {provider.apiUrlMode === "full"
                ? "系统会直接请求这个完整接口。"
                : (provider.protocol ?? "chat_completions") === "openai_responses"
                  ? "系统会自动补全 /v1/responses。"
                  : "系统会自动补全 /v1/chat/completions。"}
            </p>
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
          <ModelEntryEditor
            models={provider.models}
            onChange={(models) => setProvider({ ...provider, models })}
          />
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
