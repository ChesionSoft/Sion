import { WORKFLOW_NODES } from "./nodes";
import type { Project, ProjectNode } from "./types";

/**
 * 系统提示:整篇综合整理规则与硬约束。master 仅为表达层重组,节点原文是事实源。
 */
export function buildSynthesisSystemPrompt(): string {
  return [
    "你是项目设计文档的综合整理编辑。给你 11 个工作流节点的正文,产出一份完整的《项目开发设计文档》master markdown。",
    "",
    "## 你要做的",
    "- 生成 `## 项目概述` 前言:从已有事实提炼项目定位、范围、主要结论,不编造。",
    "- 按序产出 `## <章节标题>` 各章(章节标题用给定的 documentHeading),整理各节点正文。",
    "- 统一口径与语气;跨章去重(同一事物只在一处详述,他处简述引用);剔除分析草稿/推理残块(如“已确认的边界”“隐含要求(分析结论)”这类聊天推理);补章节过渡句。",
    "- 保留所有表格、列表、代码块等 GFM 结构。",
    "- 只输出 master markdown 本身,不要 ```markdown 围栏,不要解释,不要 `<think>` 标签。",
    "",
    "## 硬约束(不可违反)",
    "- 不编造未确认事实;不确定的归入“待确认”,不杜撰为既定结论。",
    "- 不删除已记录的待确认事项与风险。",
    "- 不新增未经讨论的需求。",
    "- 不改写已确认事实的口径,只做表达层重组。",
    "",
    "节点原文始终是事实源;你产出的 master 仅为表达层。",
  ].join("\n");
}

/**
 * 用户消息:项目元信息 + 11 个节点(跳过 final-export)的章节正文。
 */
export function buildSynthesisUserPrompt(project: Project, nodes: ProjectNode[]): string {
  const ordered = [...nodes].sort(
    (a, b) =>
      WORKFLOW_NODES.findIndex((n) => n.id === a.id) - WORKFLOW_NODES.findIndex((n) => n.id === b.id),
  );
  const chapters = ordered
    .filter((n) => n.id !== "final-export")
    .map((n) => {
      const def = WORKFLOW_NODES.find((w) => w.id === n.id);
      const heading = def?.documentHeading ?? n.id;
      return `## ${heading}\n\n${stripFirstHeading(n.markdown)}`;
    })
    .join("\n\n");

  return [
    `项目名称:${project.name}`,
    `客户名称:${project.customerName || "未填写"}`,
    `编制方:${project.authorName || "未填写"}`,
    `版本号:${project.version}`,
    "",
    "以下是各节点正文,请综合整理为 master markdown:",
    "",
    chapters,
  ].join("\n");
}

/**
 * 净化模型输出:剥思维标签、剥误加的 ```markdown 围栏、trim。
 */
export function sanitizeSynthesisOutput(text: string): string {
  let s = text;
  // 剥 <think>...</think>(含未闭合的尾部 <think>...)
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  s = s.replace(/<think>[\s\S]*$/, "");
  // 剥首尾 ```markdown / ``` 围栏
  s = s.replace(/^\s*```(?:markdown)?\s*\n([\s\S]*?)\n?\s*```\s*$/, "$1");
  return s.trim();
}

function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^# .+\n*/, "").trim();
}
