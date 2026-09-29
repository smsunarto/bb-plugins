import { describe, expect, it } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { VisibleInboxRow } from "../lib/inbox-tree.ts";
import { groupCollapseKey, type ProjectGroup } from "../lib/project-groups.ts";
import {
  buildInboxWindow,
  encodeWindowedNav,
  pinnedRowIndexes,
  windowSegments,
} from "../lib/inbox-window.ts";

function row(id: string, projectId = "p1"): VisibleInboxRow {
  const thread = { id, projectId } as PluginSidebarThread;
  return {
    node: {
      thread,
      lifecycle: "active",
      children: [],
      shelf: "nextAction",
      shelfEnteredAt: 0,
      pinOrderKey: null,
      statusThread: thread,
      matchesSearch: true,
      matchesTitle: true,
    },
    depth: 0,
    parentId: null,
    parentProjectId: null,
    parentTitle: null,
    expanded: true,
    guides: "",
    lastChild: false,
    statusThread: thread,
  };
}

function group(projectId: string, ids: string[]): ProjectGroup {
  return {
    projectId,
    rows: ids.map((id) => row(id, projectId)),
    families: ids.length,
    attention: 0,
  };
}

describe("buildInboxWindow", () => {
  it("flattens shelves, groups and rows in draw order, skipping folded ones", () => {
    const layout = buildInboxWindow(
      [
        {
          shelf: "nextAction",
          expanded: true,
          groups: [group("p1", ["a", "b"]), group("p2", ["c"])],
        },
        { shelf: "waiting", expanded: false, groups: [group("p1", ["d"])] },
        { shelf: "snoozed", expanded: true, groups: [] },
      ],
      true,
      (key) => key !== groupCollapseKey("nextAction", "p2"),
    );
    expect(layout.items.map((item) => item.key)).toEqual([
      "shelf:nextAction",
      groupCollapseKey("nextAction", "p1"),
      "row:a",
      "row:b",
      groupCollapseKey("nextAction", "p2"),
      "shelf:waiting",
    ]);
    expect([...layout.headerIndex]).toEqual([
      ["shelf:nextAction", 0],
      [groupCollapseKey("nextAction", "p1"), 1],
      [groupCollapseKey("nextAction", "p2"), 4],
      ["shelf:waiting", 5],
    ]);
    expect([...layout.rowsStart]).toEqual([[groupCollapseKey("nextAction", "p1"), 2]]);
  });

  it("hangs an ungrouped shelf's rows straight off its header", () => {
    const layout = buildInboxWindow(
      [{ shelf: "pinned", expanded: true, groups: [group("p1", ["a"]), group("p2", ["b"])] }],
      false,
      () => true,
    );
    expect(layout.items.map((item) => item.key)).toEqual(["shelf:pinned", "row:a", "row:b"]);
    expect([...layout.rowsStart]).toEqual([["shelf:pinned", 1]]);
  });
});

describe("windowSegments", () => {
  it("mounts the given rows and folds each run between them into one placeholder", () => {
    expect(windowSegments(10, 6, new Set([9, 12, 13, 16]))).toEqual([
      { kind: "placeholder", from: 0, to: 2 },
      { kind: "row", offset: 2 },
      { kind: "row", offset: 3 },
      { kind: "placeholder", from: 4, to: 6 },
    ]);
    expect(windowSegments(0, 2, new Set([0, 1]))).toEqual([
      { kind: "row", offset: 0 },
      { kind: "row", offset: 1 },
    ]);
  });
});

describe("pinnedRowIndexes", () => {
  it("pins the first nine rows and the named threads", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `t${index}`);
    const { items } = buildInboxWindow(
      [{ shelf: "nextAction", expanded: true, groups: [group("p1", ids)] }],
      true,
      () => true,
    );
    expect(pinnedRowIndexes(items, ["t11", null, undefined, "gone"])).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 13,
    ]);
  });
});

describe("encodeWindowedNav", () => {
  it("writes bb's threadId:projectId pairs in list order", () => {
    expect(encodeWindowedNav([row("a", "p1"), row("b", "p2")])).toBe("a:p1 b:p2");
  });
});
