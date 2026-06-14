import { NextResponse } from "next/server";
import { ProjectStore } from "@/lib/project/store";

const store = new ProjectStore();

export async function GET() {
  return NextResponse.json({ projects: await store.listProjects() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    customerName?: string;
    authorName?: string;
  };

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "项目名称不能为空" }, { status: 400 });
  }

  const project = await store.createProject({
    name: body.name.trim(),
    customerName: body.customerName?.trim(),
    authorName: body.authorName?.trim(),
  });

  return NextResponse.json({ project }, { status: 201 });
}
