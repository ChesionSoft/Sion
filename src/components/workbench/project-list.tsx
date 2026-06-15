"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowRightIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Project } from "@/lib/project/types";
import { ModelConfigPanel } from "./model-config-panel";

function CreateProjectForm({
  name,
  setName,
  customerName,
  setCustomerName,
  authorName,
  setAuthorName,
  error,
  setError,
  onCreated,
}: {
  name: string;
  setName: (value: string) => void;
  customerName: string;
  setCustomerName: (value: string) => void;
  authorName: string;
  setAuthorName: (value: string) => void;
  error: string;
  setError: (value: string) => void;
  onCreated: (project: Project) => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function createProject() {
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, customerName, authorName }),
      });
      const data = (await response.json()) as { project?: Project; error?: string };

      if (!response.ok || !data.project) {
        setError(data.error ?? "创建项目失败");
        return;
      }

      onCreated(data.project);
    } catch {
      setError("创建项目失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm font-medium" htmlFor="project-name">
          项目名称
        </Label>
        <Input
          id="project-name"
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：库存管理系统"
          value={name}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm font-medium" htmlFor="customer-name">
          客户名称
        </Label>
        <Input
          id="customer-name"
          onChange={(event) => setCustomerName(event.target.value)}
          placeholder="例如：某某科技有限公司"
          value={customerName}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm font-medium" htmlFor="author-name">
          编制方
        </Label>
        <Input
          id="author-name"
          onChange={(event) => setAuthorName(event.target.value)}
          placeholder="例如：ChesionSoft / 项目负责人"
          value={authorName}
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button disabled={!name.trim() || submitting} onClick={createProject} type="button">
        <PlusIcon data-icon="inline-start" />
        {submitting ? "正在创建项目..." : "创建项目工作台"}
      </Button>
    </div>
  );
}

export function ProjectList() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [error, setError] = useState("");
  const showDashboard = projects.length > 4;

  useEffect(() => {
    fetch("/api/projects")
      .then((response) => response.json())
      .then((data: { projects: Project[] }) => setProjects(data.projects))
      .catch(() => setError("项目列表读取失败"));
  }, []);

  function handleCreated(project: Project) {
    router.push(`/projects/${project.id}`);
  }

  if (!showDashboard) {
    return (
      <main className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto flex max-w-4xl flex-col gap-8 pt-24">
          <header className="text-center">
            <div className="mb-5 flex justify-center">
              <Image alt="Sion" height={64} priority src="/logo.svg" width={64} />
            </div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Sion</p>
            <h1 className="mb-3 text-4xl font-semibold tracking-tight">AI 项目设计文档工作台</h1>
            <p className="mx-auto max-w-2xl text-base text-muted-foreground">
              按 12 个节点把需求讨论、Agent 对话、文件上下文和 Markdown 编辑沉淀成可交付的项目设计文档。
            </p>
          </header>

          <div className="flex justify-center">
            <CreateProjectForm
              authorName={authorName}
              customerName={customerName}
              error={error}
              name={name}
              onCreated={handleCreated}
              setAuthorName={setAuthorName}
              setCustomerName={setCustomerName}
              setError={setError}
              setName={setName}
            />
          </div>

          {projects.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">继续已有项目</h2>
              <div className="flex flex-col gap-2">
                {projects.map((project) => (
                  <Card key={project.id} className="border shadow-none" size="sm">
                    <CardHeader>
                      <CardTitle className="text-base font-medium">{project.name}</CardTitle>
                      <CardDescription>{project.customerName || "未填写客户名称"}</CardDescription>
                      <CardAction>
                        <Button
                          onClick={() => router.push(`/projects/${project.id}`)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <ArrowRightIcon data-icon="inline-start" />
                          进入工作台
                        </Button>
                      </CardAction>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          <ModelConfigPanel />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="border-b pb-4">
          <div className="flex items-center gap-3">
            <Image alt="Sion" height={40} priority src="/logo.svg" width={40} />
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Sion</p>
              <h1 className="text-2xl font-semibold">AI 项目设计文档工作台</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                管理本地项目，把需求、文档和开发上下文保留在同一条交付路径里。
              </p>
            </div>
          </div>
        </header>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="border shadow-none">
            <CardHeader className="pb-2">
              <CardDescription>项目总数</CardDescription>
              <CardTitle className="text-2xl">{projects.length}</CardTitle>
            </CardHeader>
          </Card>
          <Card className="border shadow-none">
            <CardHeader className="pb-2">
              <CardDescription>已确认节点</CardDescription>
              <CardTitle className="text-2xl">—</CardTitle>
            </CardHeader>
          </Card>
          <Card className="border shadow-none">
            <CardHeader className="pb-2">
              <CardDescription>最近更新</CardDescription>
              <CardTitle className="text-2xl">—</CardTitle>
            </CardHeader>
          </Card>
        </section>

        <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <Card className="border shadow-none">
            <CardHeader>
              <CardTitle>新建项目</CardTitle>
              <CardDescription>创建本地项目后进入 12 节点设计路径，逐步补齐交付文档。</CardDescription>
            </CardHeader>
            <CardContent>
              <CreateProjectForm
                authorName={authorName}
                customerName={customerName}
                error={error}
                name={name}
                onCreated={handleCreated}
                setAuthorName={setAuthorName}
                setCustomerName={setCustomerName}
                setError={setError}
                setName={setName}
              />
            </CardContent>
          </Card>
          <div className="grid gap-3 md:grid-cols-2">
            {projects.map((project) => (
              <Card key={project.id} className="border shadow-none" size="sm">
                <CardHeader>
                  <CardTitle className="text-base font-medium">{project.name}</CardTitle>
                  <CardDescription>{project.customerName || "未填写客户名称"}</CardDescription>
                  <CardAction>
                    <Button
                      onClick={() => router.push(`/projects/${project.id}`)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <ArrowRightIcon data-icon="inline-start" />
                      进入工作台
                    </Button>
                  </CardAction>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        <ModelConfigPanel />
      </div>
    </main>
  );
}
