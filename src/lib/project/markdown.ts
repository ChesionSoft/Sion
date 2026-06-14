import { WORKFLOW_NODES } from "./nodes";
import type { Project, ProjectNode } from "./types";

export function assembleProjectDesignMarkdown(project: Project, nodes: ProjectNode[]): string {
  const orderedNodes = orderNodes(nodes);
  const sections = orderedNodes.map((node) => {
    const definition = WORKFLOW_NODES.find((item) => item.id === node.id);
    const body = stripFirstHeading(node.markdown);
    return [`## ${definition?.documentHeading ?? node.id}`, "", body].join("\n");
  });

  return [
    `# ${project.name}项目开发设计文档`,
    "",
    `客户名称：${project.customerName || "未填写"}`,
    "",
    `编制方：${project.authorName || "未填写"}`,
    "",
    `版本号：${project.version}`,
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "## 修订记录",
    "",
    "| 版本 | 日期 | 修改说明 | 修改人 |",
    "| --- | --- | --- | --- |",
    `| ${project.version} | ${new Date().toISOString().slice(0, 10)} | 初版 | ${project.authorName || "未填写"} |`,
    "",
    ...sections,
    "",
    "## 汇总设计假设",
    "",
    ...collectListItems(orderedNodes.flatMap((node) => node.assumptions)),
    "",
    "## 汇总待确认事项",
    "",
    ...collectListItems(orderedNodes.flatMap((node) => node.openQuestions)),
    "",
  ].join("\n");
}

export function createSpecMarkdown(project: Project, nodes: ProjectNode[]): string {
  return [
    `# ${project.name} SPEC`,
    "",
    "本文档面向开发者和 AI 开发工具，描述项目实现所需的业务、功能、数据、接口和技术约束。",
    "",
    ...orderNodes(nodes)
      .filter((node) => node.id !== "final-export")
      .map((node) =>
        [`## ${WORKFLOW_NODES.find((item) => item.id === node.id)?.title ?? node.id}`, "", stripFirstHeading(node.markdown), ""].join(
          "\n",
        ),
      ),
  ].join("\n");
}

export function createTasksMarkdown(project: Project, nodes: ProjectNode[]): string {
  const taskNode = nodes.find((node) => node.id === "development-tasks");

  return [
    `# ${project.name} 开发任务`,
    "",
    "## 任务来源",
    "",
    "- 本文件由项目设计流程中的“开发任务拆分”节点生成。",
    "",
    taskNode ? stripFirstHeading(taskNode.markdown) : "## 待拆分任务\n\n- 暂无。",
    "",
  ].join("\n");
}

export function createAgentsMarkdown(project: Project, nodes: ProjectNode[]): string {
  const openQuestions = nodes.flatMap((node) => node.openQuestions);

  return [
    "# AGENTS.md",
    "",
    `当前项目：${project.name}`,
    "",
    "## 工作原则",
    "",
    "- 优先遵循 PROJECT_DESIGN.md 与 SPEC.md。",
    "- 不确定的业务规则不要擅自扩展，先在代码或任务中标记需要确认。",
    "- 实现前先阅读 TASKS.md，并按任务依赖顺序推进。",
    "- 涉及数据结构、接口或权限变更时，同步更新相关文档。",
    "",
    "## 当前待确认事项",
    "",
    ...collectListItems(openQuestions),
    "",
  ].join("\n");
}

function orderNodes(nodes: ProjectNode[]): ProjectNode[] {
  return [...nodes].sort(
    (a, b) =>
      WORKFLOW_NODES.findIndex((node) => node.id === a.id) -
      WORKFLOW_NODES.findIndex((node) => node.id === b.id),
  );
}

function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^# .+\n*/, "").trim();
}

function collectListItems(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- 暂无。"];
}
