import assert from "node:assert/strict";
import test from "node:test";
import { NODES } from "../src/types.ts";
import {
  MORE_MENU_ITEMS,
  PRIMARY_NAV_ITEMS,
  WORKSPACE_HEADER_ACTIONS,
  WORKSPACE_NODE_ROWS,
} from "../src/workspace-config.ts";

test("workspace header actions have the approved order and distinct icons", () => {
  assert.deepEqual(
    WORKSPACE_HEADER_ACTIONS.map(({ id, label }) => [id, label]),
    [
      ["delivery", "交付稿"],
      ["agent-rules", "agent.md"],
      ["file-pool", "文件池"],
    ],
  );
  assert.equal(new Set(WORKSPACE_HEADER_ACTIONS.map(({ icon }) => icon)).size, 3);
});

test("primary navigation uses semantic icons", () => {
  assert.deepEqual(
    PRIMARY_NAV_ITEMS.map(({ id, label, icon }) => [id, label, icon]),
    [
      ["projects", "项目", "projects"],
      ["exports", "导出中心", "export"],
    ],
  );
});

test("node rows stay text-only and preserve the domain order", () => {
  assert.deepEqual(WORKSPACE_NODE_ROWS, NODES);
  assert.equal(WORKSPACE_NODE_ROWS.some((row) => row.length > 2), false);
});

test("run history lives in more instead of the primary header actions", () => {
  assert.deepEqual(MORE_MENU_ITEMS, [
    { id: "run-history", label: "运行记录", icon: "run-history" },
  ]);
  assert.equal(
    WORKSPACE_HEADER_ACTIONS.some(({ id }) => id === "run-history"),
    false,
  );
});
