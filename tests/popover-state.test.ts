import assert from "node:assert/strict";
import test from "node:test";
import { shouldClosePopoverAfterAction } from "../src/components/ui/popover-state.ts";

test("popover closes after a menu action but not inert panel content", () => {
  assert.equal(shouldClosePopoverAfterAction({ closest: () => ({}) }), true);
  assert.equal(shouldClosePopoverAfterAction({ closest: () => null }), false);
  assert.equal(shouldClosePopoverAfterAction(null), false);
});
