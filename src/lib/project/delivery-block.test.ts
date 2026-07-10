import { describe, expect, it } from "vitest";
import {
  buildDeliverySectionsList,
  extractFirstJsonObject,
  parseDeliveryBlock,
  stripDeliveryBlock,
} from "./delivery-block";

describe("parseDeliveryBlock", () => {
  it("parses a well-formed block into patches with synthesized defaults", () => {
    const content =
      "答案。\n```delivery\n" +
      JSON.stringify({
        changes: [{ sectionKey: "goals", patchKind: "append_bullet", markdown: "- 目标A" }],
      }) +
      "\n```";
    expect(parseDeliveryBlock(content)).toEqual([
      {
        category: "assumption",
        targetSectionKey: "goals",
        patchKind: "append_bullet",
        markdown: "- 目标A",
        evidence: { source: "assistant", quote: "- 目标A" },
      },
    ]);
  });

  it("returns [] when there is no delivery block", () => {
    expect(parseDeliveryBlock("纯散文回复，没有块。")).toEqual([]);
  });

  it("returns [] when the JSON is malformed", () => {
    expect(parseDeliveryBlock("```delivery\nnot json\n```")).toEqual([]);
  });

  it("recovers JSON wrapped in prose or thinking tags", () => {
    const json = JSON.stringify({
      changes: [{ sectionKey: "goals", patchKind: "append_block", markdown: "一段说明" }],
    });
    const content = "```delivery\n思考中...\n" + json + "\n```";
    expect(parseDeliveryBlock(content)).toHaveLength(1);
  });

  it("parses multiple delivery fences in order", () => {
    const one = JSON.stringify({ changes: [{ sectionKey: "goals", patchKind: "append_bullet", markdown: "- A" }] });
    const two = JSON.stringify({ changes: [{ sectionKey: "scope", patchKind: "append_bullet", markdown: "- B" }] });
    const content = "```delivery\n" + one + "\n```\n中间散文\n```delivery\n" + two + "\n```";
    expect(parseDeliveryBlock(content).map((p) => p.targetSectionKey)).toEqual(["goals", "scope"]);
  });

  it("parses a table-row patch and uses markdown as the evidence quote", () => {
    const content =
      "```delivery\n" +
      JSON.stringify({
        changes: [{ sectionKey: "module_list", patchKind: "append_table_row", markdown: "| 客户管理 | CRUD | P0 |" }],
      }) +
      "\n```";
    const patches = parseDeliveryBlock(content);
    expect(patches[0].patchKind).toBe("append_table_row");
    expect(patches[0].evidence.quote).toBe("| 客户管理 | CRUD | P0 |");
  });

  it("drops change items missing required string fields", () => {
    const content =
      "```delivery\n" +
      JSON.stringify({
        changes: [
          { sectionKey: "goals", patchKind: "append_bullet", markdown: "- 好" },
          { sectionKey: "goals", patchKind: "append_bullet" },
          { patchKind: "append_bullet", markdown: "- 无key" },
        ],
      }) +
      "\n```";
    expect(parseDeliveryBlock(content)).toHaveLength(1);
  });

  it("handles an unclosed trailing fence", () => {
    const content =
      "```delivery\n" +
      JSON.stringify({ changes: [{ sectionKey: "goals", patchKind: "append_bullet", markdown: "- 尾" }] });
    expect(parseDeliveryBlock(content).map((p) => p.markdown)).toEqual(["- 尾"]);
  });

  it("accepts targetSectionKey as an alias for sectionKey", () => {
    const content =
      "```delivery\n" +
      JSON.stringify({ changes: [{ targetSectionKey: "goals", patchKind: "append_bullet", markdown: "- 别名" }] }) +
      "\n```";
    expect(parseDeliveryBlock(content)[0].targetSectionKey).toBe("goals");
  });
});

describe("stripDeliveryBlock", () => {
  it("removes a closed fence (leaving a paragraph break)", () => {
    expect(stripDeliveryBlock("答案。\n```delivery\n{}\n```\n尾部")).toBe("答案。\n\n尾部");
  });

  it("removes an unclosed trailing fence", () => {
    expect(stripDeliveryBlock("答案。\n```delivery\n{}")).toBe("答案。");
  });

  it("leaves fence-free content intact (trailing whitespace trimmed)", () => {
    expect(stripDeliveryBlock("纯散文")).toBe("纯散文");
  });
});

describe("extractFirstJsonObject", () => {
  it("extracts the first balanced object", () => {
    expect(extractFirstJsonObject('noise {"a":{"b":1}} tail')).toBe('{"a":{"b":1}}');
  });

  it("returns null when no object is present", () => {
    expect(extractFirstJsonObject("no braces here")).toBeNull();
  });
});

describe("buildDeliverySectionsList", () => {
  it("lists sectionKey, heading, allowedPatchKinds and tableColumns", () => {
    const list = buildDeliverySectionsList("feature-design");
    expect(list).toContain('sectionKey: "module_list"');
    expect(list).toContain('tableColumns: ["模块名"');
  });
});
