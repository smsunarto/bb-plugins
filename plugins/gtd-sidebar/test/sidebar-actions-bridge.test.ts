import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PluginSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import {
  archiveThread,
  forgetSidebarActions,
  hasSidebarActions,
  publishSidebarActions,
} from "../lib/sidebar-actions-bridge.ts";

function fakeActions(archived: string[]): PluginSidebarThreadActions {
  const noop = () => {};
  return {
    open: noop,
    openNewThread: noop,
    setPinned: async () => {},
    setRead: async () => {},
    rename: async () => {},
    archive: (threadId) => {
      archived.push(threadId);
    },
    requestDelete: noop,
  };
}

describe("sidebar actions bridge", () => {
  let archived: string[];
  let actions: PluginSidebarThreadActions;

  beforeEach(() => {
    archived = [];
    actions = fakeActions(archived);
    forgetSidebarActions(actions);
  });

  it("has no actions until an inbox publishes them", () => {
    assert.equal(hasSidebarActions(), false);
    archiveThread("thr_1");
    assert.deepEqual(archived, []);
  });

  it("archives through the published actions", () => {
    publishSidebarActions(actions);
    assert.equal(hasSidebarActions(), true);
    archiveThread("thr_1");
    assert.deepEqual(archived, ["thr_1"]);
    forgetSidebarActions(actions);
  });

  it("forgets only the actions it currently holds", () => {
    const other = fakeActions([]);
    publishSidebarActions(actions);
    forgetSidebarActions(other);
    assert.equal(hasSidebarActions(), true);
    forgetSidebarActions(actions);
    assert.equal(hasSidebarActions(), false);
  });

  // A remount publishes a fresh object before the old one's cleanup runs, and
  // that cleanup must not clear what the new mount just published.
  it("keeps a newer publish when an older mount forgets", () => {
    const newer = fakeActions(archived);
    publishSidebarActions(actions);
    publishSidebarActions(newer);
    forgetSidebarActions(actions);
    assert.equal(hasSidebarActions(), true);
    archiveThread("thr_2");
    assert.deepEqual(archived, ["thr_2"]);
    forgetSidebarActions(newer);
  });
});
