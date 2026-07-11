import { describe, expect, it } from "vitest";
import { applyDraftPatches } from "./formal-prd-patcher";
import type { DraftPatch } from "./formal-prd";

const DOC = [
  "## 背景",
  "",
  "背景正文。",
  "",
  "## 数据结构",
  "",
  "数据结构引言。",
  "",
  "### 字段",
  "",
  "字段说明。",
  "",
].join("\n");

function patch(ops: DraftPatch["ops"]): DraftPatch {
  return { artifactDigest: "d", ops };
}

describe("applyDraftPatches", () => {
  it("replaces only the body of an H2 section (nested H3 is inside the replaced range)", () => {
    const { markdown, applied } = applyDraftPatches(
      DOC,
      patch([{ op: "replace", heading: "数据结构", body: "新数据结构正文。" }]),
    );
    expect(applied).toEqual([{ op: expect.any(Object), status: "applied" }]);
    expect(markdown).toContain("## 数据结构\n\n新数据结构正文。");
    // the nested H3 and old intro were part of the replaced body
    expect(markdown).not.toContain("字段说明。");
    expect(markdown).not.toContain("数据结构引言。");
    // the prior section is untouched
    expect(markdown).toContain("## 背景\n\n背景正文。");
  });

  it("removes an H2 and all its nested content", () => {
    const { markdown, applied } = applyDraftPatches(DOC, patch([{ op: "remove", heading: "数据结构" }]));
    expect(applied[0].status).toBe("applied");
    expect(markdown).not.toContain("数据结构");
    expect(markdown).not.toContain("字段说明。");
    expect(markdown).toContain("## 背景\n\n背景正文。");
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  it("inserts a new section after the anchor heading", () => {
    const { markdown, applied } = applyDraftPatches(
      DOC,
      patch([{ op: "insert", heading: "新增", body: "新增正文。", afterHeading: "背景" }]),
    );
    expect(applied[0].status).toBe("applied");
    expect(markdown).toContain("## 背景\n\n背景正文。\n\n## 新增\n\n新增正文。");
    // the rest of the document is preserved after the inserted section
    expect(markdown).toContain("## 数据结构");
  });

  it("appends a new section when afterHeading is omitted", () => {
    const { markdown, applied } = applyDraftPatches(
      DOC,
      patch([{ op: "insert", heading: "附录", body: "附录正文。" }]),
    );
    expect(applied[0].status).toBe("applied");
    expect(markdown).toMatch(/字段说明。\n\n## 附录\n\n附录正文。\n$/);
  });

  it("skips a missing target and still applies a later valid op", () => {
    const { markdown, applied } = applyDraftPatches(
      DOC,
      patch([
        { op: "replace", heading: "不存在", body: "x" },
        { op: "remove", heading: "字段" }, // H3, not an H2 target -> skipped
        { op: "replace", heading: "背景", body: "新背景。" },
      ]),
    );
    expect(applied).toHaveLength(3);
    expect(applied[0].status).toBe("skipped");
    expect(applied[0].reason).toBeTruthy();
    expect(applied[1].status).toBe("skipped");
    expect(applied[2].status).toBe("applied");
    expect(markdown).toContain("## 背景\n\n新背景。");
  });

  it("skips a missing insert anchor and still applies a later valid op", () => {
    const { markdown, applied } = applyDraftPatches(
      DOC,
      patch([
        { op: "insert", heading: "新增", body: "正文。", afterHeading: "不存在" },
        { op: "insert", heading: "附录", body: "附录正文。" },
      ]),
    );
    expect(applied).toHaveLength(2);
    expect(applied[0].status).toBe("skipped");
    expect(applied[1].status).toBe("applied");
    expect(markdown).toContain("## 附录");
  });

  it("skips an ambiguous duplicate H2 and still applies a later valid op", () => {
    const dupDoc = `${DOC}\n## 背景\n\n重复背景。\n`;
    const { markdown, applied } = applyDraftPatches(
      dupDoc,
      patch([
        { op: "replace", heading: "背景", body: "x" },
        { op: "replace", heading: "数据结构", body: "新数据结构。" },
      ]),
    );
    expect(applied).toHaveLength(2);
    expect(applied[0].status).toBe("skipped");
    expect(applied[0].reason).toContain("重复");
    expect(applied[1].status).toBe("applied");
    expect(markdown).toContain("## 数据结构\n\n新数据结构。");
    // the duplicate background is untouched because the replace was skipped
    expect(markdown).toContain("重复背景。");
  });

  it("skips a replacement body containing an H2 line and still applies a later valid op", () => {
    const { markdown, applied } = applyDraftPatches(
      DOC,
      patch([
        { op: "replace", heading: "背景", body: "## 偷渡标题\n\n正文。" },
        { op: "replace", heading: "数据结构", body: "新数据结构。" },
      ]),
    );
    expect(applied).toHaveLength(2);
    expect(applied[0].status).toBe("skipped");
    expect(applied[0].reason).toContain("二级标题");
    expect(applied[1].status).toBe("applied");
    expect(markdown).toContain("## 数据结构\n\n新数据结构。");
    // original background body is intact
    expect(markdown).toContain("## 背景\n\n背景正文。");
  });

  it("skips inserted or indented replacement bodies that introduce an H2", () => {
    const { markdown, applied } = applyDraftPatches(
      DOC,
      patch([
        { op: "insert", heading: "新增", body: "新增正文。\n## 偷渡章节\n\n不应写入。" },
        { op: "replace", heading: "背景", body: "  ## 缩进偷渡\n\n不应写入。" },
      ]),
    );
    expect(applied.map((result) => result.status)).toEqual(["skipped", "skipped"]);
    expect(markdown).not.toContain("偷渡章节");
    expect(markdown).not.toContain("缩进偷渡");
  });
});
