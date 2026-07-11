import { WORKFLOW_NODES } from "./nodes";
import type { FormalPrdBlueprint } from "./formal-prd";
import type { Project, ProjectNode } from "./types";

/**
 * Staged formal-PRD generation prompts.
 *
 * Stage 1 (blueprint): the model curates which node content maps into which
 * formal section, marking open questions / history / process noise as `omit`.
 * Stage 2 (draft): the model writes the formal Markdown body strictly from the
 * approved blueprint, never re-introducing forbidden material.
 */

export function buildBlueprintSystemPrompt(): string {
  return [
    "你是对外正式 PRD 的内容编排编辑，只输出一个 JSON 对象。",
    "节点正文是事实源；不得新增产品事实、案例、承诺或待确认项。",
    "未确认内容默认 omit；不要写待确认、TBD、补充建议或过程性检查。",
    "每个纳入章节必须标明 sourceNodeIds、sourceHeadings、inclusion 和 presentation。",
    "inclusion 取值：confirmed | confirmed-summary | omit | required-disclosure。",
    "presentation 取值：paragraphs | bullets | table | flow | appendix。",
    "用 ```json 围栏包裹唯一一个 JSON 对象，不要任何解释或前后文。",
  ].join("\n");
}

export function buildBlueprintUserPrompt(project: Project, nodes: ProjectNode[]): string {
  const ordered = [...nodes].sort(
    (a, b) =>
      WORKFLOW_NODES.findIndex((n) => n.id === a.id) - WORKFLOW_NODES.findIndex((n) => n.id === b.id),
  );
  const chapters = ordered
    .filter((n) => n.id !== "final-export")
    .map((n) => {
      const def = WORKFLOW_NODES.find((w) => w.id === n.id);
      const heading = def?.documentHeading ?? n.id;
      return `### ${heading}（nodeId: ${n.id}）\n${stripFirstHeading(n.markdown)}`;
    })
    .join("\n\n");

  return [
    `项目名称：${project.name}`,
    `客户名称：${project.customerName || "未填写"}`,
    `编制方：${project.authorName || "未填写"}`,
    `版本号：${project.version}`,
    "",
    "以下是各节点正文（final-export 除外）。请编排为正式 PRD 导出蓝图 JSON：",
    "",
    chapters,
    "",
    'JSON 结构：{"title":"正式 PRD 导出蓝图","sections":[{"id":"","title":"","inclusion":"","presentation":"","sourceNodeIds":[],"sourceHeadings":[],"rationale":""}]}',
  ].join("\n");
}

export function buildDraftSystemPrompt(): string {
  return [
    "你是正式 PRD 撰稿编辑，只按批准的导出蓝图输出 Markdown 正文。",
    "只能使用蓝图所列节点和小节的已确认事实。",
    "不得输出待确认、建议、历史记录、agent 过程、字段全集或接口全集。",
    "表格只用于重复可比较的信息；流程使用 ```flow 代码块，内容仅为一条主链路。",
    "不适用的小节直接省略，不要留空、不要编造事实。",
    "只输出 Markdown 正文，不要 ```markdown 围栏，不要解释。",
  ].join("\n");
}

export function buildDraftUserPrompt(blueprint: FormalPrdBlueprint, nodes: ProjectNode[]): string {
  const referenced = new Set(blueprint.sections.flatMap((s) => s.sourceNodeIds));
  const ordered = [...nodes].sort(
    (a, b) =>
      WORKFLOW_NODES.findIndex((n) => n.id === a.id) - WORKFLOW_NODES.findIndex((n) => n.id === b.id),
  );
  const sources = ordered
    .filter((n) => referenced.has(n.id))
    .map((n) => {
      const def = WORKFLOW_NODES.find((w) => w.id === n.id);
      const heading = def?.documentHeading ?? n.id;
      return `### ${heading}（nodeId: ${n.id}）\n${stripFirstHeading(n.markdown)}`;
    })
    .join("\n\n");

  const sectionList = blueprint.sections
    .map(
      (s) =>
        `- ${s.title}（id=${s.id}, inclusion=${s.inclusion}, presentation=${s.presentation}, source=${s.sourceNodeIds.join(",") || "-"}）`,
    )
    .join("\n");

  return [
    "已批准的导出蓝图章节：",
    sectionList,
    "",
    "对应源节点正文（仅蓝图引用的节点）：",
    sources,
    "",
    "请按蓝图章节顺序输出正式 PRD Markdown 正文。",
  ].join("\n");
}

/**
 * Parse a single JSON object from a model response. Accepts exactly one fenced
 * ```json block, or a bare JSON object that is the whole payload. Rejects
 * prose-without-JSON, multiple fenced blocks, and malformed JSON.
 */
export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/g;
  const fenced: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(trimmed)) !== null) {
    fenced.push(match[1].trim());
  }

  let payload: string;
  if (fenced.length === 1) {
    payload = fenced[0];
  } else if (fenced.length === 0) {
    payload = trimmed;
  } else {
    throw new Error("模型未返回有效 JSON：存在多个代码块");
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("模型未返回有效 JSON");
  }
}

function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^# .+\n*/, "").trim();
}