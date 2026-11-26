import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  archiveThread,
  canSettleThread,
  forgetSidebarActions,
  hasSidebarActions,
  openNewCaptain,
  publishSidebarActions,
  settleThread,
  type PublishedSidebarActions,
} from "../lib/sidebar-actions-bridge.ts";

function fakeEntry(settled: string[], stayOpen: readonly string[] = []): PublishedSidebarActions {
  return {
    settle: (threadId) => settled.push(threadId),
    canSettle: (threadId) => !stayOpen.includes(threadId),
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

  // The palette's settle row asks first, so a Captain never offers it.
  it("answers canSettle from the mounted list, and false with none", () => {
    assert.equal(canSettleThread("thr_1"), false);
    const captain = fakeEntry(settled, ["thr_captain"]);
    publishSidebarActions(captain);
    assert.equal(canSettleThread("thr_1"), true);
    assert.equal(canSettleThread("thr_captain"), false);
    forgetSidebarActions(captain);
  });

  it("forwards openNewCaptain to the mounted list when published", () => {
    const opened: (string | null | undefined)[] = [];
    const actions: PublishedSidebarActions = {
      ...fakeEntry(settled),
      openNewCaptain: (projectId) => opened.push(projectId),
    };
    openNewCaptain("proj_1");
    assert.deepEqual(opened, []);
    publishSidebarActions(actions);
    openNewCaptain();
    openNewCaptain("proj_1");
    assert.deepEqual(opened, [undefined, "proj_1"]);
    forgetSidebarActions(actions);
  });
});
