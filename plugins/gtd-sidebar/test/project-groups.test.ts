import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { buildInboxTree, visibleInboxRows } from "../lib/inbox-tree.ts";
import {
  groupCollapseKey,
  groupRowsByProject,
  needsUser,
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
  it("groups roots by project in the order the shelf already sorts them", () => {
    const groups = groupRowsByProject(
      rows([
        thread("a", { latestAttentionAt: 300 }),
        thread("b", { projectId: "two", latestAttentionAt: 250 }),
        thread("c", { latestAttentionAt: 200 }),
        thread("d", { projectId: "three", latestAttentionAt: 100 }),
      ]),
    );
    assert.deepEqual(
      groups.map((group) => [group.projectId, ids(group)]),
      [
        ["one", ["a", "c"]],
        ["two", ["b"]],
        ["three", ["d"]],
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
