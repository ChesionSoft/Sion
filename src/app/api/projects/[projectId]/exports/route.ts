import { NextResponse } from "next/server";
import { exportProjectDocuments } from "@/lib/project/exports";
import { ProjectStore } from "@/lib/project/store";

const store = new ProjectStore();

export async function POST(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const result = await exportProjectDocuments(store, projectId);
  return NextResponse.json(result);
}
