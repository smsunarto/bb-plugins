import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PluginSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import {
  archiveThread,
  forgetSidebarActions,
  hasSidebarActions,
  publishSidebarActions,
  settleThread,
  type PublishedSidebarActions,
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

function fakeEntry(settled: string[]): PublishedSidebarActions {
  return {
    actions: fakeActions([]),
    settle: (threadId) => settled.push(threadId),
  };
}

describe("sidebar actions bridge", () => {
  let settled: string[];
  let entry: PublishedSidebarActions;

  beforeEach(() => {
    settled = [];
    entry = fakeEntry(settled);
    forgetSidebarActions(entry);
  });

  it("has no actions until an inbox publishes them", () => {
    assert.equal(hasSidebarActions(), false);
    settleThread("thr_1");
    assert.deepEqual(settled, []);
  });

  it("settles through the published dispatcher", () => {
    publishSidebarActions(entry);
    assert.equal(hasSidebarActions(), true);
    settleThread("thr_1");
    assert.deepEqual(settled, ["thr_1"]);
    forgetSidebarActions(entry);
  });

  it("keeps the archiveThread entry settling until the palette can move over", () => {
    publishSidebarActions(entry);
    archiveThread("thr_1");
    assert.deepEqual(settled, ["thr_1"]);
    forgetSidebarActions(entry);
  });

  it("forgets only the entry it currently holds", () => {
    const other = fakeEntry([]);
    publishSidebarActions(entry);
    forgetSidebarActions(other);
    assert.equal(hasSidebarActions(), true);
    forgetSidebarActions(entry);
    assert.equal(hasSidebarActions(), false);
  });

  // A remount publishes a fresh object before the old one's cleanup runs, and
  // that cleanup must not clear what the new mount just published.
  it("keeps a newer publish when an older mount forgets", () => {
    const newer = fakeEntry(settled);
    publishSidebarActions(entry);
    publishSidebarActions(newer);
    forgetSidebarActions(entry);
    assert.equal(hasSidebarActions(), true);
    settleThread("thr_2");
    assert.deepEqual(settled, ["thr_2"]);
    forgetSidebarActions(newer);
  });
});
