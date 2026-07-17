import assert from "node:assert/strict";
import test from "node:test";
import {
  closeNode,
  closeRightTab,
  durableUiSettings,
  initialProjectUi,
  openNode,
  openRightTab,
} from "../src/ui-state.ts";

test("first project open initializes basic info and delivery", () => {
  assert.deepEqual(initialProjectUi(), {
    initialized: true,
    openedNodeIds: ["basic-info"],
    activeNodeId: "basic-info",
    tabsInitialized: true,
    rightTabIds: ["delivery"],
    activeRightTabId: "delivery",
    rightPaneWidth: 440,
  });
});

test("closing the last node preserves an intentional empty state", () => {
  const state = closeNode(initialProjectUi(), "basic-info");
  assert.deepEqual(state.openedNodeIds, []);
  assert.equal(state.activeNodeId, null);
  assert.equal(state.initialized, true);
});

test("closing active node selects the most recent remaining node", () => {
  let state = openNode(initialProjectUi(), "goals");
  state = openNode(state, "business-flow");
  state = closeNode(state, "business-flow");
  assert.equal(state.activeNodeId, "goals");
});

test("closing the final right tab keeps tabs initialized and empty", () => {
  const state = closeRightTab(initialProjectUi(), "delivery");
  assert.deepEqual(state.rightTabIds, []);
  assert.equal(state.activeRightTabId, null);
});

test("transient preview tabs are excluded from persisted settings", () => {
  const state = openRightTab(initialProjectUi(), "delivery-preview:message-1");
  const durable = durableUiSettings({
    sidebarCollapsed: false,
    lastDestination: "projects",
    projects: { p1: state },
  });
  assert.deepEqual(durable.projects.p1.rightTabIds, ["delivery"]);
});
