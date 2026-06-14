"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Project } from "@/lib/project/types";

export function ProjectList() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((response) => response.json())
      .then((data: { projects: Project[] }) => setProjects(data.projects))
      .catch(() => setError("项目列表读取失败"));
  }, []);

  async function createProject() {
    setError("");
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

    router.push(`/projects/${data.project.id}`);
  }

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex items-end justify-between border-b pb-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Sion</p>
            <h1 className="text-2xl font-semibold">项目设计文档工作台</h1>
          </div>
        </header>
        <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>新建项目</CardTitle>
              <CardDescription>创建本地项目后进入 12 节点设计流程。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="project-name">项目名称</Label>
                <Input id="project-name" onChange={(event) => setName(event.target.value)} value={name} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="customer-name">客户名称</Label>
                <Input id="customer-name" onChange={(event) => setCustomerName(event.target.value)} value={customerName} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="author-name">编制方</Label>
                <Input id="author-name" onChange={(event) => setAuthorName(event.target.value)} value={authorName} />
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button disabled={!name.trim()} onClick={createProject} type="button">
                <PlusIcon data-icon="inline-start" />
                创建项目
              </Button>
            </CardContent>
          </Card>
          <div className="flex flex-col gap-3">
            {projects.map((project) => (
              <Card key={project.id} size="sm">
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription>{project.customerName || "未填写客户名称"}</CardDescription>
                  <CardAction>
                    <Button onClick={() => router.push(`/projects/${project.id}`)} type="button" variant="outline">
                      <ArrowRightIcon data-icon="inline-start" />
                      打开
                    </Button>
                  </CardAction>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
