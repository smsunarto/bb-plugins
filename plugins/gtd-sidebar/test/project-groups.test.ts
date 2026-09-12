import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { buildInboxTree, visibleInboxRows } from "../lib/inbox-tree.ts";
import {
  applyProjectMove,
  groupCollapseKey,
  groupRowsByProject,
  needsUser,
  projectDropEdge,
  projectDropReorderArgs,
  projectReorderArgs,
  settleProjectOrderOverride,
  shouldGroupByProject,
} from "../lib/project-groups.ts";

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    projectId: "one",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
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

function rows(threads: PluginSidebarThread[], shelf = "nextAction") {
  const tree = buildInboxTree(threads, () => "active").filter((node) => node.shelf === shelf);
  return visibleInboxRows(tree, new Set());
}

const ids = (group: { rows: { node: { thread: { id: string } } }[] }) =>
  group.rows.map((row) => row.node.thread.id);

describe("project groups", () => {
  it("orders groups by bb's project order, not by their threads", () => {
    // bb's order puts "three" first even though its most recent thread is the
    // oldest in the shelf.
    const groups = groupRowsByProject(
      rows([
        thread("a", { latestAttentionAt: 300 }),
        thread("b", { projectId: "two", latestAttentionAt: 250 }),
        thread("c", { latestAttentionAt: 200 }),
        thread("d", { projectId: "three", latestAttentionAt: 100 }),
      ]),
      ["three", "one", "two"],
    );
    assert.deepEqual(
      groups.map((group) => [group.projectId, ids(group)]),
      [
        ["three", ["d"]],
        ["one", ["a", "c"]],
        ["two", ["b"]],
      ],
    );
  });

  it("sorts projects missing from bb's order after the known ones", () => {
    const groups = groupRowsByProject(
      rows([thread("mystery", { projectId: "gone" }), thread("a")]),
      ["one"],
    );
    assert.deepEqual(
      groups.map((group) => group.projectId),
      ["one", "gone"],
    );
  });

  it("puts projectless roots after every project group, however recent they are", () => {
    const isProjectless = (projectId: string) => projectId === "proj_personal";
    const groups = groupRowsByProject(
      rows([
        thread("loose", { projectId: "proj_personal", latestAttentionAt: 400 }),
        thread("a", { latestAttentionAt: 300 }),
        thread("b", { projectId: "two", latestAttentionAt: 250 }),
        thread("loose-child", { parentThreadId: "loose", projectId: "one" }),
        thread("c", { latestAttentionAt: 200 }),
      ]),
      ["two", "one"],
      isProjectless,
    );
    assert.deepEqual(
      groups.map((group) => [group.projectId, ids(group)]),
      [
        ["two", ["b"]],
        ["one", ["a", "c"]],
        ["proj_personal", ["loose", "loose-child"]],
      ],
    );
  });

  it("keeps a child under its root whatever project the child belongs to", () => {
    const groups = groupRowsByProject(
      rows([
        thread("root"),
        thread("child", { parentThreadId: "root", projectId: "two" }),
        thread("other", { projectId: "two", latestAttentionAt: 50 }),
      ]),
    );
    assert.deepEqual(
      groups.map((group) => [group.projectId, ids(group), group.families]),
      [
        ["one", ["root", "child"], 1],
        ["two", ["other"], 1],
      ],
    );
  });

  it("counts families that need the user, by the family's loudest status", () => {
    const groups = groupRowsByProject(
      rows([
        thread("quiet"),
        thread("unread", { isUnread: true, latestAttentionAt: 90 }),
        thread("parent", { latestAttentionAt: 80 }),
        thread("asking", { parentThreadId: "parent", hasPendingInteraction: true }),
      ]),
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.families, 3);
    assert.equal(groups[0]!.attention, 2);
  });

  it("asks for headers only once a second project shows up anywhere", () => {
    const one = rows([thread("a"), thread("b")]);
    const empty: never[] = [];
    assert.equal(
      shouldGroupByProject({
        pinned: empty,
        nextAction: one,
        waiting: empty,
        snoozed: empty,
        settled: empty,
      }),
      false,
    );
    assert.equal(
      shouldGroupByProject({
        pinned: empty,
        nextAction: one,
        waiting: empty,
        snoozed: rows([thread("z", { projectId: "two" })]),
        settled: empty,
      }),
      true,
    );
    // A child from another project does not count: it sits under its root.
    assert.equal(
      shouldGroupByProject({
        pinned: empty,
        nextAction: rows([
          thread("root"),
          thread("child", { parentThreadId: "root", projectId: "two" }),
        ]),
        waiting: empty,
        snoozed: empty,
        settled: empty,
      }),
      false,
    );
  });

  it("keys collapse state by shelf and project", () => {
    assert.notEqual(groupCollapseKey("nextAction", "one"), groupCollapseKey("waiting", "one"));
    assert.equal(groupCollapseKey("waiting", "one"), groupCollapseKey("waiting", "one"));
  });

  it("treats every raised-hand status as needing the user", () => {
    assert.equal(needsUser(thread("a")), false);
    assert.equal(needsUser(thread("a", { indicator: "runtime" })), false);
    assert.equal(needsUser(thread("a", { isUnread: true })), true);
    assert.equal(needsUser(thread("a", { hasPendingInteraction: true })), true);
    assert.equal(needsUser(thread("a", { indicator: "waiting-for-input" })), true);
    assert.equal(needsUser(thread("a", { indicator: "unread-error" })), true);
  });
});

describe("projectReorderArgs", () => {
  const order = ["one", "two", "three"];

  it("moves up past the group above it in the shelf", () => {
    assert.deepEqual(projectReorderArgs("three", "up", ["one", "two", "three"], order), {
      previousProjectId: "one",
      nextProjectId: "two",
    });
  });

  it("moves down past the group below it in the shelf", () => {
    assert.deepEqual(projectReorderArgs("one", "down", ["one", "two", "three"], order), {
      previousProjectId: "two",
      nextProjectId: "three",
    });
  });

  it("jumps a project the shelf does not show", () => {
    // "hidden" has no rows in this shelf; moving "three" up past "two" lands
    // it ahead of both in bb's order, so every shelf agrees.
    assert.deepEqual(
      projectReorderArgs("three", "up", ["two", "three"], ["two", "hidden", "three"]),
      { previousProjectId: null, nextProjectId: "two" },
    );
  });

  it("anchors at the ends with null neighbours", () => {
    assert.deepEqual(projectReorderArgs("three", "up", ["one", "three"], order), {
      previousProjectId: null,
      nextProjectId: "one",
    });
    assert.deepEqual(projectReorderArgs("one", "down", ["one", "three"], order), {
      previousProjectId: "three",
      nextProjectId: null,
    });
  });

  it("refuses moves with no group on that side", () => {
    assert.equal(projectReorderArgs("one", "up", ["one", "two"], order), null);
    assert.equal(projectReorderArgs("two", "down", ["one", "two"], order), null);
  });

  it("refuses projects outside bb's order, including the personal project", () => {
    assert.equal(projectReorderArgs("proj_personal", "up", ["one", "proj_personal"], order), null);
    // Moving onto the personal group is refused too: nothing goes below it.
    assert.equal(projectReorderArgs("one", "down", ["one", "proj_personal"], order), null);
    assert.equal(projectReorderArgs("one", "down", ["one", "gone"], order), null);
  });
});

describe("projectDropEdge", () => {
  it("lands after a lower target and before a higher one", () => {
    // In a vertical sortable the dragged item takes the target's index, so
    // dragging down ends below the target and dragging up ends above it.
    assert.equal(projectDropEdge(0, 2), "after");
    assert.equal(projectDropEdge(2, 0), "before");
    assert.equal(projectDropEdge(0, 1), "after");
    assert.equal(projectDropEdge(1, 0), "before");
  });

  it("refuses the same index and unknown indices", () => {
    assert.equal(projectDropEdge(1, 1), null);
    assert.equal(projectDropEdge(-1, 0), null);
    assert.equal(projectDropEdge(0, -1), null);
  });
});

describe("projectDropReorderArgs", () => {
  const order = ["one", "two", "three"];

  it("drops a group on the shelf's first group to move it to the top", () => {
    // "three" dragged onto "one" lands before it — first in bb's order.
    assert.deepEqual(projectDropReorderArgs("three", "one", "before", order), {
      previousProjectId: null,
      nextProjectId: "one",
    });
  });

  it("drops a group between two others", () => {
    assert.deepEqual(projectDropReorderArgs("one", "two", "after", order), {
      previousProjectId: "two",
      nextProjectId: "three",
    });
    assert.deepEqual(projectDropReorderArgs("three", "two", "before", order), {
      previousProjectId: "one",
      nextProjectId: "two",
    });
  });

  it("drops a group on the shelf's last group to move it to the bottom", () => {
    assert.deepEqual(projectDropReorderArgs("one", "three", "after", order), {
      previousProjectId: "three",
      nextProjectId: null,
    });
  });

  it("jumps projects the shelf does not show, anchored in bb's full order", () => {
    // The shelf only renders ["one", "three"] but bb's order carries
    // "hidden" between them; dropping "one" after "three" lands it at the
    // end of bb's order, past the hidden project too.
    const full = ["one", "hidden", "three"];
    assert.deepEqual(projectDropReorderArgs("one", "three", "after", full), {
      previousProjectId: "three",
      nextProjectId: null,
    });
    // And dropping "three" before "one" jumps it ahead of "hidden" as well.
    assert.deepEqual(projectDropReorderArgs("three", "one", "before", full), {
      previousProjectId: null,
      nextProjectId: "one",
    });
  });

  it("resolves against the full order, not the shelf's visible groups", () => {
    // The shelf's visible groups are ["hidden", "two"] of bb's full
    // ["one", "hidden", "two", "three"]; dropping "two" before "hidden"
    // anchors at the very top, not at the shelf's second slot.
    const full = ["one", "hidden", "two", "three"];
    assert.deepEqual(projectDropReorderArgs("two", "hidden", "before", full), {
      previousProjectId: "one",
      nextProjectId: "hidden",
    });
  });

  it("refuses a drop that asks for the slot the project already holds", () => {
    // "two" dropped after "one" would sit exactly where it is.
    assert.equal(projectDropReorderArgs("two", "one", "after", order), null);
    // "two" dropped before "three" likewise.
    assert.equal(projectDropReorderArgs("two", "three", "before", order), null);
  });

  it("refuses a drop on itself and projects outside bb's order", () => {
    assert.equal(projectDropReorderArgs("one", "one", "after", order), null);
    // The personal project is never in bb's order, so it cannot move and
    // nothing can land relative to it.
    assert.equal(projectDropReorderArgs("proj_personal", "one", "before", order), null);
    assert.equal(projectDropReorderArgs("one", "proj_personal", "after", order), null);
    assert.equal(projectDropReorderArgs("gone", "one", "before", order), null);
  });
});

describe("applyProjectMove", () => {
  const order = ["one", "two", "three"];

  it("predicts the order the resolved anchors describe", () => {
    assert.deepEqual(
      applyProjectMove(order, "three", { previousProjectId: null, nextProjectId: "one" }),
      ["three", "one", "two"],
    );
    assert.deepEqual(
      applyProjectMove(order, "one", { previousProjectId: "three", nextProjectId: null }),
      ["two", "three", "one"],
    );
    assert.deepEqual(
      applyProjectMove(order, "one", { previousProjectId: "two", nextProjectId: "three" }),
      ["two", "one", "three"],
    );
  });

  it("moves within the full order, hidden projects included", () => {
    assert.deepEqual(
      applyProjectMove(["one", "hidden", "three"], "three", {
        previousProjectId: null,
        nextProjectId: "one",
      }),
      ["three", "one", "hidden"],
    );
  });
});

describe("settleProjectOrderOverride", () => {
  it("replaces the matching prediction with bb's canonical unchanged order", () => {
    const optimistic = ["beta", "alpha", "gamma"];
    const canonical = ["alpha", "beta", "gamma"];

    assert.equal(settleProjectOrderOverride(optimistic, optimistic, canonical), canonical);
  });

  it("does not let an older response replace a newer drag", () => {
    const first = ["beta", "alpha", "gamma"];
    const second = ["gamma", "beta", "alpha"];

    assert.equal(settleProjectOrderOverride(second, first, ["alpha", "beta", "gamma"]), second);
  });
});
