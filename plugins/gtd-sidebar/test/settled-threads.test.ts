import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  isUnread,
  isWithinSettledWindow,
  mergeSettledThreads,
  pendingSettledCount,
  settledIndicator,
  toSidebarThread,
  SETTLED_WINDOW_MS,
  type SettledThreadRow,
} from "../lib/settled-threads.ts";
import { parseArchivedThreadIds, type ThreadLifecycleRow } from "../lib/lifecycle.ts";

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

function lifecycleRow(overrides: Partial<ThreadLifecycleRow> = {}): ThreadLifecycleRow {
  return {
    threadId: "thr_1",
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    ...overrides,
  };
}

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

  it("keeps a settle from inside the window", () => {
    assert.equal(isWithinSettledWindow(now - 1, now), true);
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS + 1, now), true);
  });

  // The row and the archive both stay; only the drawing stops.
  it("drops a settle older than the window", () => {
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS, now), false);
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS - 1, now), false);
  });

  // A clock that moved must not swallow a settle the user just made.
  it("keeps a settle stamped in the future", () => {
    assert.equal(isWithinSettledWindow(now + SETTLED_WINDOW_MS, now), true);
  });

  it("is a day by default", () => {
    assert.equal(SETTLED_WINDOW_MS, 24 * 60 * 60 * 1000);
  });
});

describe("settledIndicator", () => {
  // A settled thread is a quiet one — anything else un-settles it — so this is
  // the answer for nearly every row on the shelf.
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

  // The mapping has to stay faithful here: `resolveShelf` reads it back to
  // decide the thread has come back, and a row that reported itself quiet
  // while it worked would stay parked forever.
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
  it("marks the thread archived, which is why this path exists", () => {
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

describe("pendingSettledCount", () => {
  const now = 10 * SETTLED_WINDOW_MS;
  const nothingVisible: ReadonlySet<string> = new Set();

  // The whole reason this exists: settling archives the thread, so bb reports
  // nothing and `listSettledThreads` is a round trip away. The seeded row is
  // all the shelf has to go on, and a collapsed shelf only ever needed a count.
  it("counts a settled thread the host cannot report", () => {
    assert.equal(
      pendingSettledCount([lifecycleRow({ settledAt: now - 1 })], nothingVisible, now),
      1,
    );
  });

  // A snoozed thread is not archived, so bb keeps reporting it and the snooze
  // shelf draws it from these same rows. Counting it here would add it to the
  // settled header as well.
  it("ignores a row that is not settled", () => {
    assert.equal(
      pendingSettledCount(
        [lifecycleRow({ snoozedUntil: now + 1, snoozedAt: now - 1 })],
        nothingVisible,
        now,
      ),
      0,
    );
  });

  // A settle whose archive failed, and every thread settled before this plugin
  // archived anything, stay in the host's list — `resolveShelf` already puts
  // them on the shelf. Counting them would draw the header one too high for as
  // long as they sit there, not for one round trip.
  it("ignores a settled thread the host still reports", () => {
    assert.equal(
      pendingSettledCount(
        [lifecycleRow({ threadId: "thr_9", settledAt: now - 1 })],
        new Set(["thr_9"]),
        now,
      ),
      0,
    );
  });

  // Recomputed against a fresh clock for exactly this: a row the cache seeded
  // hours ago has to leave the header on its own, with no refetch to say so.
  // A stored count could not do it.
  it("drops a settle that has aged out of the window", () => {
    assert.equal(
      pendingSettledCount(
        [lifecycleRow({ settledAt: now - SETTLED_WINDOW_MS })],
        nothingVisible,
        now,
      ),
      0,
    );
  });

  it("counts each pending row once and nothing else", () => {
    const rows = [
      lifecycleRow({ threadId: "a", settledAt: now - 1 }),
      lifecycleRow({ threadId: "b", settledAt: now - 2 }),
      lifecycleRow({ threadId: "c", settledAt: now - 3 }),
    ];
    assert.equal(pendingSettledCount(rows, new Set(["b"]), now), 2);
  });

  // A first-ever run, a cleared origin, or storage switched off: the count is
  // zero and the list behaves exactly as it did before any of this. A miss must
  // degrade, never invent a header for a shelf with nothing on it.
  it("counts nothing when no row was seeded", () => {
    assert.equal(pendingSettledCount([], nothingVisible, now), 0);
  });

  // The hook holds a Map keyed by thread id, and hands over its values.
  it("reads any iterable of rows", () => {
    const rows = new Map([["a", lifecycleRow({ threadId: "a", settledAt: now - 1 })]]);
    assert.equal(pendingSettledCount(rows.values(), nothingVisible, now), 1);
  });
});

describe("parseArchivedThreadIds", () => {
  it("reads back what settle stored", () => {
    assert.deepEqual(parseArchivedThreadIds('["thr_1","thr_2"]'), ["thr_1", "thr_2"]);
  });

  // Rows written before the cascade column, and anything a hand-edited
  // database holds. The caller falls back to the thread's own id.
  it("gives nothing back for a missing or unusable value", () => {
    assert.deepEqual(parseArchivedThreadIds(null), []);
    assert.deepEqual(parseArchivedThreadIds("not json"), []);
    assert.deepEqual(parseArchivedThreadIds('{"threadId":"thr_1"}'), []);
    assert.deepEqual(parseArchivedThreadIds('["thr_1",7]'), ["thr_1"]);
  });
});
