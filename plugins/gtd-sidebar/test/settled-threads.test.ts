import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  isUnread,
  isWithinSettledWindow,
  mergeSettledThreads,
  settledIndicator,
  settledRowsMatch,
  toSidebarThread,
  SETTLED_WINDOW_MS,
  type SettledThreadRow,
} from "../lib/settled-threads.ts";

function row(overrides: Partial<SettledThreadRow> = {}): SettledThreadRow {
  return {
    id: "thr_1",
    settledAt: 1_000,
    projectId: "proj_1",
    title: "A settled thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    hasPendingInteraction: false,
    isPinned: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

function hostThread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return { ...toSidebarThread(row()), isArchived: false, ...overrides };
}

describe("settledRowsMatch", () => {
  it("matches identical snapshots with separately allocated rows and activity", () => {
    const current = [row(), row({ id: "thr_2" })];
    assert.equal(settledRowsMatch(current, structuredClone(current)), true);
    assert.equal(settledRowsMatch(current, current), true);
    assert.equal(settledRowsMatch([], []), true);
  });

  it("detects every snapshot field change", () => {
    const changedFields = {
      id: "thr_2",
      settledAt: 1_001,
      projectId: "proj_2",
      title: null,
      titleFallback: "Fallback title",
      parentThreadId: "thr_parent",
      sectionId: "section_1",
      originKind: "fork",
      originPluginId: "plugin_1",
      providerId: "claude",
      status: "active",
      hasPendingInteraction: true,
      isPinned: true,
      activity: { ...row().activity, workflows: 1 },
      createdAt: 101,
      updatedAt: 101,
      lastReadAt: null,
      latestAttentionAt: 101,
    } satisfies SettledThreadRow;
    for (const key of Object.keys(changedFields) as Array<keyof SettledThreadRow>) {
      const changed = row({ [key]: changedFields[key] });
      assert.equal(settledRowsMatch([row()], [changed]), false, key);
      assert.equal(settledRowsMatch([changed], [row()]), false, key);
    }
  });

  it("detects each nested activity change", () => {
    const changedActivity = {
      workflows: 1,
      backgroundAgents: 1,
      backgroundCommands: 1,
      planMode: 1,
      goals: 1,
    } satisfies SettledThreadRow["activity"];
    for (const key of Object.keys(changedActivity) as Array<keyof SettledThreadRow["activity"]>) {
      assert.equal(
        settledRowsMatch([row()], [row({ activity: { ...row().activity, [key]: 1 } })]),
        false,
        key,
      );
    }
  });

  it("detects row additions, deletions, and order changes", () => {
    const first = row();
    const second = row({ id: "thr_2" });
    assert.equal(settledRowsMatch([first], [first, second]), false);
    assert.equal(settledRowsMatch([first, second], [first]), false);
    assert.equal(settledRowsMatch([first, second], [second, first]), false);
    assert.equal(settledRowsMatch([first], []), false);
    assert.equal(settledRowsMatch([], [first]), false);
  });
});

describe("isUnread", () => {
  it("is bb's own rule: last read has to catch up with last attention", () => {
    assert.equal(isUnread(row({ lastReadAt: 100, latestAttentionAt: 100 })), false);
    assert.equal(isUnread(row({ lastReadAt: 100, latestAttentionAt: 101 })), true);
  });

  it("treats a never-read thread as unread", () => {
    assert.equal(isUnread(row({ lastReadAt: null, latestAttentionAt: 1 })), true);
  });
});

describe("isWithinSettledWindow", () => {
  const now = 10 * SETTLED_WINDOW_MS;

  it("keeps an archive from inside the window", () => {
    assert.equal(isWithinSettledWindow(now - 1, now), true);
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS + 1, now), true);
  });

  // The archive stays; only the drawing stops.
  it("drops an archive older than the window", () => {
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS, now), false);
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS - 1, now), false);
  });

  // A clock that moved must not swallow a settle the user just made.
  it("keeps an archive stamped in the future", () => {
    assert.equal(isWithinSettledWindow(now + SETTLED_WINDOW_MS, now), true);
  });

  it("is a day by default", () => {
    assert.equal(SETTLED_WINDOW_MS, 24 * 60 * 60 * 1000);
  });
});

describe("settledIndicator", () => {
  it("draws nothing for a quiet thread", () => {
    assert.deepEqual(settledIndicator(row()), {
      indicator: "none",
      indicatorLabel: null,
    });
  });

  it("puts a raised hand above everything else", () => {
    const result = settledIndicator(row({ hasPendingInteraction: true, status: "active" }));
    assert.equal(result.indicator, "waiting-for-input");
  });

  it("reports live work from the status", () => {
    assert.equal(settledIndicator(row({ status: "active" })).indicator, "runtime");
  });

  it("reports live work from an activity count alone", () => {
    const working = row({
      activity: {
        workflows: 1,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    assert.equal(settledIndicator(working).indicator, "runtime");
  });

  it("separates an unread failure from an unread success", () => {
    const unread = { lastReadAt: 100, latestAttentionAt: 200 };
    assert.equal(settledIndicator(row({ ...unread, status: "error" })).indicator, "unread-error");
    assert.equal(settledIndicator(row({ ...unread, status: "idle" })).indicator, "unread-success");
  });
});

describe("toSidebarThread", () => {
  it("marks the thread archived, which is what shelves it", () => {
    assert.equal(toSidebarThread(row()).isArchived, true);
  });

  it("keeps only the origin kind this sidebar draws", () => {
    assert.equal(toSidebarThread(row({ originKind: "fork" })).originKind, "fork");
    // A kind bb adds later, or one it has since dropped, must degrade rather
    // than crash the shelf.
    assert.equal(toSidebarThread(row({ originKind: "side-chat" })).originKind, null);
    assert.equal(toSidebarThread(row({ originKind: "teleport" })).originKind, null);
  });

  it("carries the fields the list sorts, filters, and searches on", () => {
    const mapped = toSidebarThread(
      row({
        id: "thr_9",
        projectId: "proj_2",
        title: null,
        titleFallback: "ask about the parser",
        parentThreadId: "thr_parent",
        createdAt: 42,
        isPinned: true,
      }),
    );
    assert.equal(mapped.id, "thr_9");
    assert.equal(mapped.projectId, "proj_2");
    assert.equal(mapped.titleFallback, "ask about the parser");
    assert.equal(mapped.parentThreadId, "thr_parent");
    assert.equal(mapped.createdAt, 42);
    assert.equal(mapped.isPinned, true);
  });
});

describe("mergeSettledThreads", () => {
  it("adds the settled threads the host cannot report", () => {
    const merged = mergeSettledThreads(
      [hostThread({ id: "a" })],
      [toSidebarThread(row({ id: "b" }))],
    );
    assert.deepEqual(
      merged.map((t) => t.id),
      ["a", "b"],
    );
  });

  // The host's view is live and this one is a round trip old: a thread bb has
  // already unarchived must not be dragged back by a stale copy of itself.
  it("lets the host win a collision", () => {
    const merged = mergeSettledThreads(
      [hostThread({ id: "a" })],
      [toSidebarThread(row({ id: "a" }))],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.isArchived, false);
  });

  it("returns the host list unchanged when nothing is settled", () => {
    const merged = mergeSettledThreads([hostThread({ id: "a" })], []);
    assert.deepEqual(
      merged.map((t) => t.id),
      ["a"],
    );
  });
});
