import { describe, expect, it } from "vitest";
import { WORKFLOW_NODES } from "./nodes";
import { getDeliverySchema, getDeliverySection } from "./node-delivery-schemas";
import type { WorkflowNodeId } from "./types";

describe("getDeliverySchema", () => {
  it("returns a schema for every workflow node", () => {
    for (const node of WORKFLOW_NODES) {
      const schema = getDeliverySchema(node.id);
      expect(schema, `Missing schema for node ${node.id}`).toBeDefined();
      expect(schema!.nodeId).toBe(node.id);
    }
  });

  it("returns undefined for unknown node ids", () => {
    expect(getDeliverySchema("unknown" as WorkflowNodeId)).toBeUndefined();
  });

  it("matches documentHeading from WORKFLOW_NODES for every node", () => {
    for (const node of WORKFLOW_NODES) {
      const schema = getDeliverySchema(node.id)!;
      expect(schema.documentHeading).toBe(node.documentHeading);
    }
  });

  it("has unique section keys within each schema", () => {
    for (const node of WORKFLOW_NODES) {
      const schema = getDeliverySchema(node.id)!;
      const keys = schema.sections.map((s) => s.key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size, `Duplicate section keys in ${node.id}`).toBe(keys.length);
    }
  });

  it("has valid heading and level on every section", () => {
    for (const node of WORKFLOW_NODES) {
      const schema = getDeliverySchema(node.id)!;
      for (const section of schema.sections) {
        expect(section.heading, `Empty heading in ${node.id}/${section.key}`).toBeTruthy();
        expect(
          [2, 3],
          `Invalid level ${section.level} in ${node.id}/${section.key}`,
        ).toContain(section.level);
      }
    }
  });

  it("does not carry confirmed/assumptions/open_questions meta sections in any schema", () => {
    // These three fixed meta-sections were removed so the delivery document
    // only contains the node's real content sections. Assumptions/inferred
    // content now goes directly into content sections; open questions stay in
    // the chat and are never written to the document.
    for (const node of WORKFLOW_NODES) {
      const schema = getDeliverySchema(node.id)!;
      const keys = schema.sections.map((s) => s.key);
      expect(keys, `confirmed present in ${node.id}`).not.toContain("confirmed");
      expect(keys, `assumptions present in ${node.id}`).not.toContain("assumptions");
      expect(keys, `open_questions present in ${node.id}`).not.toContain("open_questions");
      expect(
        schema.sections.length,
        `${node.id} should keep at least one content section`,
      ).toBeGreaterThan(0);
    }
  });

  it("every section with append_table_row has non-empty unique tableColumns", () => {
    for (const node of WORKFLOW_NODES) {
      const schema = getDeliverySchema(node.id)!;
      for (const section of schema.sections) {
        if (!section.allowedPatchKinds.includes("append_table_row")) continue;
        expect(
          section.tableColumns,
          `Missing tableColumns in ${node.id}/${section.key}`,
        ).toBeDefined();
        expect(
          section.tableColumns!.length,
          `Empty tableColumns in ${node.id}/${section.key}`,
        ).toBeGreaterThan(0);
        const uniqueCols = new Set(section.tableColumns!);
        expect(
          uniqueCols.size,
          `Duplicate tableColumns in ${node.id}/${section.key}`,
        ).toBe(section.tableColumns!.length);
      }
    }
  });

  it("no section has append_table_row without tableColumns", () => {
    for (const node of WORKFLOW_NODES) {
      const schema = getDeliverySchema(node.id)!;
      for (const section of schema.sections) {
        if (section.allowedPatchKinds.includes("append_table_row")) {
          expect(section.tableColumns).toBeDefined();
        }
      }
    }
  });
});

describe("getDeliverySection", () => {
  it("returns the correct section for a known nodeId and sectionKey", () => {
    const section = getDeliverySection("basic-info", "metadata");
    expect(section).toBeDefined();
    expect(section!.key).toBe("metadata");
    expect(section!.heading).toBe("基础信息表");
  });

  it("returns undefined for an unknown section key", () => {
    const section = getDeliverySection("basic-info", "nonexistent");
    expect(section).toBeUndefined();
  });

  it("returns undefined for an unknown node id", () => {
    const section = getDeliverySection("unknown" as WorkflowNodeId, "assumptions");
    expect(section).toBeUndefined();
  });
});
