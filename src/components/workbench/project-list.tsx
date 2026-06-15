"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
          placeholder="输入项目名称"
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
          placeholder="输入客户名称"
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
          placeholder="输入编制方"
          value={authorName}
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button disabled={!name.trim() || submitting} onClick={createProject} type="button">
        <PlusIcon data-icon="inline-start" />
        {submitting ? "创建中..." : "创建项目"}
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
            <p className="mb-2 text-xs font-medium text-muted-foreground">Sion</p>
            <h1 className="mb-3 text-4xl font-semibold tracking-tight">项目设计文档工作台</h1>
            <p className="text-base text-muted-foreground">本地优先的 AI 辅助设计文档工具</p>
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
              <h2 className="text-sm font-medium text-muted-foreground">已有项目</h2>
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
                          打开
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
          <p className="mb-1 text-xs font-medium text-muted-foreground">Sion</p>
          <h1 className="text-2xl font-semibold">项目设计文档工作台</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理和继续你的本地设计文档项目</p>
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
              <CardDescription>已完成节点</CardDescription>
              <CardTitle className="text-2xl">—</CardTitle>
            </CardHeader>
          </Card>
          <Card className="border shadow-none">
            <CardHeader className="pb-2">
              <CardDescription>最近活跃</CardDescription>
              <CardTitle className="text-2xl">—</CardTitle>
            </CardHeader>
          </Card>
        </section>

        <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <Card className="border shadow-none">
            <CardHeader>
              <CardTitle>新建项目</CardTitle>
              <CardDescription>创建本地项目后进入 12 节点设计流程。</CardDescription>
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
                      打开
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
