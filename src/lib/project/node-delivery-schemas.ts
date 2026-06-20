import type { PatchKind, WorkflowNodeId } from "./types";

/**
 * Describes a single section within a workflow node's delivery document.
 */
export type DeliverySection = {
  key: string;
  heading: string; // without ## prefix
  level: 2 | 3;
  required: boolean;
  allowedPatchKinds: PatchKind[];
  tableColumns?: string[];
};

/**
 * Describes the full delivery document structure for a workflow node.
 */
export type NodeDeliverySchema = {
  nodeId: WorkflowNodeId;
  documentHeading: string;
  sections: DeliverySection[];
};

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const SCHEMAS: NodeDeliverySchema[] = [
  {
    nodeId: "basic-info",
    documentHeading: "1. 项目基本信息",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "metadata",
        heading: "基础信息表",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["字段", "值"],
      },
      {
        key: "boundary",
        heading: "项目边界",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "goals",
    documentHeading: "2. 需求背景与建设目标",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "background",
        heading: "需求背景",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "goals",
        heading: "建设目标",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "scope",
        heading: "范围边界",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "roles-permissions",
    documentHeading: "3. 用户角色与权限",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "roles",
        heading: "角色清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["角色", "职责", "备注"],
      },
      {
        key: "permissions",
        heading: "权限矩阵",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["角色", "模块", "权限"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "business-flow",
    documentHeading: "4. 业务流程设计",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "flows",
        heading: "核心业务流程",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "steps",
        heading: "流程步骤",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "feature-design",
    documentHeading: "5. 功能模块设计",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "module_list",
        heading: "功能模块清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["模块名", "职责一句话", "优先级(P0/P1/P2)"],
      },
      {
        key: "module_details",
        heading: "模块详情",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "permission_matrix",
        heading: "权限矩阵",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["角色", "可操作模块", "受限操作"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "page-interaction",
    documentHeading: "6. 页面与交互设计",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "pages",
        heading: "页面清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["页面", "路径", "主要功能"],
      },
      {
        key: "interactions",
        heading: "关键交互",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "data-structure",
    documentHeading: "7. 数据结构设计",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "entities",
        heading: "实体清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["实体", "说明", "关键关系"],
      },
      {
        key: "fields",
        heading: "字段说明",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "api-design",
    documentHeading: "8. 接口设计",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "endpoints",
        heading: "接口清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["方法", "路径", "说明"],
      },
      {
        key: "details",
        heading: "接口详情",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "architecture-deployment",
    documentHeading: "9. 技术架构与部署",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "stack",
        heading: "技术栈",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "deployment",
        heading: "部署方案",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "dependencies",
        heading: "依赖清单",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "development-tasks",
    documentHeading: "10. 开发任务拆分",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "tasks",
        heading: "任务清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_table_row"],
        tableColumns: ["任务", "模块", "估时"],
      },
      {
        key: "sequencing",
        heading: "排期与依赖",
        level: 2,
        required: false,
        allowedPatchKinds: ["append_block"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "risks-open-questions",
    documentHeading: "11. 待确认事项与风险",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "risks",
        heading: "风险清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_items",
        heading: "待确认事项",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
  {
    nodeId: "final-export",
    documentHeading: "12. 最终文档生成",
    sections: [
      {
        key: "confirmed",
        heading: "已确认内容",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet", "append_block"],
      },
      {
        key: "export_checklist",
        heading: "导出检查清单",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "assumptions",
        heading: "设计假设",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
      {
        key: "open_questions",
        heading: "待确认问题",
        level: 2,
        required: true,
        allowedPatchKinds: ["append_bullet"],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const SCHEMA_BY_NODE_ID = new Map<WorkflowNodeId, NodeDeliverySchema>(
  SCHEMAS.map((s) => [s.nodeId, s]),
);

/**
 * Returns the delivery schema for the given workflow node, or undefined if
 * the node id is unknown.
 */
export function getDeliverySchema(nodeId: WorkflowNodeId): NodeDeliverySchema | undefined {
  return SCHEMA_BY_NODE_ID.get(nodeId);
}

/**
 * Returns a specific section within a node's delivery schema, or undefined
 * if the node or section key is unknown.
 */
export function getDeliverySection(
  nodeId: WorkflowNodeId,
  sectionKey: string,
): DeliverySection | undefined {
  const schema = SCHEMA_BY_NODE_ID.get(nodeId);
  if (!schema) return undefined;
  return schema.sections.find((s) => s.key === sectionKey);
}
