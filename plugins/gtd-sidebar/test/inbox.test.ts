import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { buildInboxTree, createShelfArrivals, visibleInboxRows } from "../lib/inbox-tree.ts";
import {
  activeSectionFor,
  childrenOf,
  filterByProject,
  nextThreadIdAfterSettle,
  parentOf,
  threadDisplayTitle,
} from "../lib/inbox.ts";

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

describe("active sections", () => {
  it("puts quiet work with the user and live work in waiting", () => {
    assert.equal(activeSectionFor(thread()), "next-action");
    assert.equal(activeSectionFor(thread({ indicator: "runtime" })), "waiting");
    assert.equal(
      activeSectionFor(
        thread({
          activity: {
            workflows: 0,
            backgroundAgents: 0,
            backgroundCommands: 1,
            planMode: 0,
            goals: 0,
          },
        }),
      ),
      "waiting",
    );
  });

  it("puts a pending interaction in next action even with live work", () => {
    assert.equal(
      activeSectionFor(
        thread({
          hasPendingInteraction: true,
          activity: {
            workflows: 1,
            backgroundAgents: 0,
            backgroundCommands: 0,
            planMode: 0,
            goals: 0,
          },
        }),
      ),
      "next-action",
    );
  });
});

describe("threadDisplayTitle", () => {
  it("prefers the title, then the fallback, then a placeholder", () => {
    assert.equal(threadDisplayTitle(thread({ title: "Real" })), "Real");
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: "Fallback" })),
      "Fallback",
    );
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: null })),
      "Untitled thread",
    );
  });

  it("treats a whitespace-only title as absent", () => {
    assert.equal(
      threadDisplayTitle(thread({ title: "   ", titleFallback: "Fallback" })),
      "Fallback",
    );
  });
});

describe("filtering", () => {
  it("scopes to one project, or to all", () => {
    const threads = [thread({ id: "a", projectId: "p1" }), thread({ id: "b", projectId: "p2" })];
    assert.deepEqual(
      filterByProject(threads, "p1").map((t) => t.id),
      ["a"],
    );
    assert.equal(filterByProject(threads, null).length, 2);
  });
});

describe("nextThreadIdAfterSettle", () => {
  const section = [thread({ id: "a" }), thread({ id: "b" }), thread({ id: "c" })];

  it("moves a focused thread to the row below it", () => {
    assert.equal(nextThreadIdAfterSettle(section, "b", "b"), "c");
  });

  it("falls back to the row above when settling the final row", () => {
    assert.equal(nextThreadIdAfterSettle(section, "c", "c"), "b");
  });

  it("does not move focus when settling an unfocused thread", () => {
    assert.equal(nextThreadIdAfterSettle(section, "b", "a"), null);
  });

  it("returns no target when the section has no adjacent row", () => {
    assert.equal(nextThreadIdAfterSettle([thread({ id: "only" })], "only", "only"), null);
  });
});

describe("child threads", () => {
  it("lists a thread's children oldest first", () => {
    const children = childrenOf(
      [
        thread({ id: "parent" }),
        thread({ id: "b", parentThreadId: "parent", createdAt: 20 }),
        thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
        thread({ id: "other", parentThreadId: "elsewhere" }),
      ],
      "parent",
    );
    assert.deepEqual(
      children.map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("parentOf", () => {
  // The list hides an archived parent, but the child's header must still get
  // it back — otherwise the child is a dead end.
  it("finds a parent the inbox filters out", () => {
    const parent = parentOf(
      [
        thread({ id: "parent", isArchived: true, projectId: "other" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    assert.equal(parent?.id, "parent");
  });

  it("returns null for a root thread", () => {
    assert.equal(parentOf([thread({ id: "root" })], "root"), null);
  });

  it("returns null when the parent row is gone", () => {
    const threads = [thread({ id: "child", parentThreadId: "deleted" })];
    assert.equal(parentOf(threads, "child"), null);
  });
});

describe("inbox families", () => {
  const active = () => "active" as const;
  const ids = (rows: ReturnType<typeof visibleInboxRows>) => rows.map((row) => row.node.thread.id);

  it("renders nested preorder and only advances through expanded rows", () => {
    const tree = buildInboxTree(
      [
        thread({ id: "root" }),
        thread({ id: "child", parentThreadId: "root", createdAt: 101 }),
        thread({ id: "grandchild", parentThreadId: "child" }),
        thread({ id: "sibling", parentThreadId: "root", createdAt: 102 }),
      ],
      active,
    );
    const open = visibleInboxRows(tree, new Set());
    assert.deepEqual(ids(open), ["root", "child", "grandchild", "sibling"]);
    assert.deepEqual(
      open.map((row) => row.depth),
      [0, 1, 2, 1],
    );
    assert.deepEqual(
      open.map((row) => [row.guides, row.lastChild]),
      [
        ["", false],
        ["", false],
        ["1", true],
        ["", true],
      ],
    );
    const collapsed = visibleInboxRows(tree, new Set(["child"]));
    assert.deepEqual(ids(collapsed), ["root", "child", "sibling"]);
    assert.equal(
      nextThreadIdAfterSettle(
        collapsed.map((row) => row.node.thread),
        "child",
        "child",
      ),
      "sibling",
    );
  });

  it("detaches parked children and active children of parked parents", () => {
    const tree = buildInboxTree(
      [
        thread({ id: "root" }),
        thread({ id: "snoozed", parentThreadId: "root" }),
        thread({ id: "settled", parentThreadId: "root", isArchived: true }),
        thread({ id: "active-child", parentThreadId: "settled" }),
      ],
      (item) => (item.id === "snoozed" ? "snoozed" : "active"),
    );
    assert.equal(tree.length, 4);
    assert.deepEqual(
      tree.map((node) => [node.thread.id, node.lifecycle]),
      [
        ["active-child", "active"],
        ["root", "active"],
        ["snoozed", "snoozed"],
        ["settled", "settled"],
      ],
    );
  });

  it("keeps forks and orphans reachable and breaks cycles", () => {
    const input = [
      thread({ id: "root" }),
      thread({ id: "fork", originKind: "fork", parentThreadId: "root" }),
      thread({ id: "orphan", parentThreadId: "missing" }),
      thread({ id: "a", parentThreadId: "b" }),
      thread({ id: "b", parentThreadId: "a" }),
      thread({ id: "self", parentThreadId: "self" }),
    ];
    const tree = buildInboxTree(input, active);
    const rows = visibleInboxRows(tree, new Set());
    assert.equal(rows.length, input.length);
    assert.equal(new Set(ids(rows)).size, input.length);
    assert.equal(rows.find((row) => row.node.thread.id === "fork")?.depth, 0);
    assert.equal(parentOf(input, "fork"), null);
    assert.deepEqual(childrenOf(input, "root"), []);
  });

  it("keeps a working family in waiting even with unread descendants", () => {
    const root = thread({ id: "root", indicator: "runtime" });
    const child = thread({
      id: "child",
      parentThreadId: "root",
      indicator: "runtime",
      isUnread: true,
    });
    const tree = buildInboxTree([root, child], active);
    assert.equal(tree[0]?.shelf, "waiting");
    assert.equal(visibleInboxRows(tree, new Set(["root"]))[0]?.statusThread, child);
    assert.equal(visibleInboxRows(tree, new Set())[0]?.statusThread, root);
    assert.equal(tree[0]?.lifecycle, "active");
  });

  it("moves a quiet family into waiting while any subthread is working", () => {
    const tree = buildInboxTree(
      [
        thread({ id: "root" }),
        thread({ id: "idle", parentThreadId: "root", isUnread: true }),
        thread({ id: "mid", parentThreadId: "root" }),
        thread({ id: "deep", parentThreadId: "mid", indicator: "runtime" }),
      ],
      active,
    );
    assert.equal(tree[0]?.shelf, "waiting");
    assert.equal(tree[0]?.children.find((node) => node.thread.id === "mid")?.shelf, "waiting");
    assert.equal(tree[0]?.children.find((node) => node.thread.id === "idle")?.shelf, "nextAction");
  });

  it("brings a working family back when any member raises a hand", () => {
    const tree = buildInboxTree(
      [
        thread({ id: "root" }),
        thread({ id: "busy", parentThreadId: "root", indicator: "runtime" }),
        thread({ id: "asking", parentThreadId: "root", hasPendingInteraction: true }),
      ],
      active,
    );
    assert.equal(tree[0]?.shelf, "nextAction");
  });

  it("keeps a family pinned when a descendant is pinned", () => {
    const tree = buildInboxTree(
      [
        thread({ id: "other", latestAttentionAt: 900 }),
        thread({ id: "root", indicator: "runtime" }),
        thread({ id: "child", parentThreadId: "root", isPinned: true }),
      ],
      active,
    );
    assert.deepEqual(ids(visibleInboxRows(tree, new Set())), ["root", "child", "other"]);
    assert.equal(tree[0]?.shelf, "pinned");
    assert.equal(tree[0]?.thread.isPinned, false);
  });

  it("reveals matching descendants with ancestors and preserves a matching parent's family", () => {
    const input = [
      thread({ id: "root", title: "Project" }),
      thread({ id: "child", title: null, titleFallback: "Needle", parentThreadId: "root" }),
      thread({ id: "sibling", title: "Elsewhere", parentThreadId: "root" }),
    ];
    assert.deepEqual(
      ids(
        visibleInboxRows(buildInboxTree(input, active, " NEEDLE "), new Set(["root"]), " NEEDLE "),
      ),
      ["root", "child"],
    );
    assert.deepEqual(
      ids(visibleInboxRows(buildInboxTree(input, active, "project"), new Set(["root"]), "project")),
      ["root", "child", "sibling"],
    );
    assert.deepEqual(
      ids(visibleInboxRows(buildInboxTree(input, active, "   "), new Set(), "   ")),
      ["root", "child", "sibling"],
    );
  });

  it("keeps stable creation and id ties without mutating the roster", () => {
    for (const indicator of ["none", "runtime"] as const) {
      const input = Object.freeze([
        Object.freeze(thread({ id: "b", createdAt: 1, indicator })),
        Object.freeze(thread({ id: "c", createdAt: 2, indicator })),
        Object.freeze(thread({ id: "a", createdAt: 1, indicator })),
      ]);
      const tree = buildInboxTree(input, active);
      assert.deepEqual(ids(visibleInboxRows(tree, new Set())), ["c", "a", "b"]);
      assert.deepEqual(
        input.map((item) => item.id),
        ["b", "c", "a"],
      );
    }
  });

  it("seeds a first build from each shelf's arrival clock", () => {
    const tree = buildInboxTree(
      [
        thread({ id: "waiting-old", indicator: "runtime", updatedAt: 10, latestAttentionAt: 1000 }),
        thread({ id: "renamed", latestAttentionAt: 10, updatedAt: 900 }),
        thread({ id: "active", latestAttentionAt: 50, updatedAt: 10 }),
        thread({ id: "waiting-new", indicator: "runtime", updatedAt: 20, latestAttentionAt: 1 }),
        thread({ id: "settled-first", isArchived: true }),
        thread({ id: "settled-second", isArchived: true }),
      ],
      active,
      "",
      { settledAtFor: (item) => ({ "settled-first": 1, "settled-second": 500 })[item.id] ?? null },
    );
    assert.deepEqual(
      tree.map((node) => node.thread.id),
      ["active", "renamed", "waiting-new", "waiting-old", "settled-second", "settled-first"],
    );
  });
});

describe("shelf arrival order", () => {
  const active = () => "active" as const;
  const ids = (tree: ReturnType<typeof buildInboxTree>) => tree.map((node) => node.thread.id);

  it("keeps a row's place while its clocks bump inside one shelf", () => {
    const arrivals = createShelfArrivals();
    const first = buildInboxTree(
      [
        thread({ id: "a", latestAttentionAt: 300 }),
        thread({ id: "b", latestAttentionAt: 200 }),
        thread({ id: "w", indicator: "runtime", updatedAt: 100 }),
      ],
      active,
      "",
      { arrivals },
    );
    assert.deepEqual(ids(first), ["a", "b", "w"]);

    // Reading b and a rename on w bump both clocks. Same shelf, same place.
    const bumped = buildInboxTree(
      [
        thread({ id: "a", latestAttentionAt: 300 }),
        thread({ id: "b", latestAttentionAt: 9_999, updatedAt: 9_999 }),
        thread({ id: "w", indicator: "runtime", updatedAt: 8_888 }),
      ],
      active,
      "",
      { arrivals },
    );
    assert.deepEqual(ids(bumped), ["a", "b", "w"]);

    // Without session memory the same bump would re-sort b to the top.
    const cold = buildInboxTree(
      [
        thread({ id: "a", latestAttentionAt: 300 }),
        thread({ id: "b", latestAttentionAt: 9_999, updatedAt: 9_999 }),
        thread({ id: "w", indicator: "runtime", updatedAt: 8_888 }),
      ],
      active,
    );
    assert.deepEqual(ids(cold), ["b", "a", "w"]);
  });

  it("re-enters a shelf at the top after leaving it", () => {
    const arrivals = createShelfArrivals();
    buildInboxTree(
      [
        thread({ id: "a", latestAttentionAt: 100 }),
        thread({ id: "b", indicator: "runtime", updatedAt: 200 }),
      ],
      active,
      "",
      { arrivals },
    );
    // a starts a new turn: nextAction -> waiting is a shelf move, so it lands
    // on top of the waiting b arrived in earlier.
    const tree = buildInboxTree(
      [
        thread({ id: "a", indicator: "runtime", latestAttentionAt: 100, updatedAt: 400 }),
        thread({ id: "b", indicator: "runtime", updatedAt: 900 }),
      ],
      active,
      "",
      { arrivals, now: 1_000 },
    );
    assert.deepEqual(ids(tree), ["a", "b"]);
    assert.equal(tree[0]?.shelf, "waiting");
  });

  it("sorts snoozed by when the snooze was set, re-snooze included", () => {
    const arrivals = createShelfArrivals();
    const snoozedAt: Record<string, number> = { s1: 100, s2: 200 };
    const sort = {
      arrivals,
      snoozedAtFor: (item: PluginSidebarThread) => snoozedAt[item.id] ?? null,
    };
    const snoozeAll = () => "snoozed" as const;
    const tree = buildInboxTree([thread({ id: "s1" }), thread({ id: "s2" })], snoozeAll, "", sort);
    assert.deepEqual(ids(tree), ["s2", "s1"]);

    // A re-snooze rewrites snoozedAt, and the live key lands the row on top.
    snoozedAt["s1"] = 300;
    const resnoozed = buildInboxTree(
      [thread({ id: "s1" }), thread({ id: "s2" })],
      snoozeAll,
      "",
      sort,
    );
    assert.deepEqual(ids(resnoozed), ["s1", "s2"]);
  });

  it("sorts settled by when it settled, not by input order", () => {
    const tree = buildInboxTree(
      [
        thread({ id: "old", isArchived: true }),
        thread({ id: "new", isArchived: true }),
        thread({ id: "mid", isArchived: true }),
      ],
      active,
      "",
      { settledAtFor: (item) => ({ old: 10, mid: 20, new: 30 })[item.id] ?? null },
    );
    assert.deepEqual(ids(tree), ["new", "mid", "old"]);
  });

  it("sorts a family by the root's arrival — a busier child never pulls it up", () => {
    const arrivals = createShelfArrivals();
    const tree = buildInboxTree(
      [
        thread({ id: "a", latestAttentionAt: 200 }),
        thread({ id: "f", latestAttentionAt: 100 }),
        thread({
          id: "f-child",
          parentThreadId: "f",
          latestAttentionAt: 9_999,
          updatedAt: 9_999,
        }),
      ],
      active,
      "",
      { arrivals },
    );
    assert.deepEqual(ids(tree), ["a", "f"]);
  });
});
