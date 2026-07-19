import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldClosePopoverAfterAction } from "../src/components/ui/popover-state.ts";

test("popover closes after a menu action but not inert panel content", () => {
  assert.equal(shouldClosePopoverAfterAction({ closest: () => ({}) }), true);
  assert.equal(shouldClosePopoverAfterAction({ closest: () => null }), false);
  assert.equal(shouldClosePopoverAfterAction(null), false);
});

test("popover lets a menu action run before closing its panel", async () => {
  const source = await readFile("src/components/ui/Popover.tsx", "utf8");

  assert.match(source, /onClick=\{\(event\) => \{ if \(shouldClosePopoverAfterAction\(event\.target\)\) setOpen\(false\); \}\}/);
  assert.doesNotMatch(source, /onClickCapture=/);
});
