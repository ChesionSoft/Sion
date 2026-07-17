import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedMarkdownUrl,
  markdownImageLabel,
} from "../src/markdown-policy.ts";

test("markdown preview blocks every navigable or loadable URL", () => {
  assert.equal(blockedMarkdownUrl("https://example.com/image.png"), "");
  assert.equal(blockedMarkdownUrl("file:///Users/test/secret.txt"), "");
  assert.equal(blockedMarkdownUrl("javascript:alert(1)"), "");
  assert.equal(blockedMarkdownUrl("/relative/path"), "");
});

test("markdown images become readable non-loading placeholders", () => {
  assert.equal(markdownImageLabel("架构图"), "[图片：架构图]");
  assert.equal(markdownImageLabel(""), "[图片：未命名]");
  assert.equal(markdownImageLabel(undefined), "[图片：未命名]");
});
