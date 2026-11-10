import { describe, expect, test } from "vitest";
import {
  groupItems,
  isSlopCop,
  lineEdits,
  moveAnchor,
  type Anchor,
  type ReviewItem,
} from "./items.ts";

const at = (
  line: number,
  startLine: number | null = null,
  side: "LEFT" | "RIGHT" = "RIGHT",
): Anchor => ({
  path: "a.ts",
  line,
  startLine,
  side,
  head: "old1",
});

describe("a new head", () => {
  // Old lines 1–20; line 5 replaced by two lines, two lines inserted after line 12, line 18 removed.
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "@@ -4,3 +4,4 @@",
    " four",
    "-five",
    "+five a",
    "+five b",
    " six",
    "@@ -12,0 +14,2 @@",
    "+thirteen a",
    "+thirteen b",
    "@@ -17,3 +19,2 @@",
    " seventeen",
    "-eighteen",
    " nineteen",
  ].join("\n");
  const edits = lineEdits(patch, false);

  test("reads removals and insertions on the old file's lines", () => {
    expect(edits.removed).toEqual([5, 18]);
    expect(edits.inserted).toEqual([
      { at: 6, count: 2 },
      { at: 13, count: 2 },
    ]);
  });

  test.each([
    ["above every edit", at(2), at(2)],
    ["between edits", at(8), { ...at(9) }],
    ["below an insertion", at(14), at(17)],
    ["below a removal", at(20), at(22)],
    ["a range around nothing", at(9, 7), at(10, 8)],
  ])("a line %s moves with them", (_name, anchor, expected) => {
    expect(moveAnchor(anchor, edits, "new1")).toEqual({ ...expected, head: "new1" });
  });

  test.each([
    ["a removed line", at(5)],
    ["a range holding an insertion", at(13, 12)],
    ["a range holding a removal", at(19, 17)],
  ])("%s is outdated", (_name, anchor) => {
    expect(moveAnchor(anchor, edits, "new1")).toBeNull();
  });

  test("a file the head did not touch, a base-side line and a whole-file comment keep their lines", () => {
    expect(moveAnchor(at(5), undefined, "new1")).toEqual({ ...at(5), head: "new1" });
    expect(moveAnchor(at(5, null, "LEFT"), edits, "new1")).toEqual({
      ...at(5, null, "LEFT"),
      head: "new1",
    });
    expect(moveAnchor({ ...at(5), line: null }, edits, "new1")?.line).toBeNull();
  });

  test("a deleted file outdates everything on it", () => {
    expect(moveAnchor(at(2), lineEdits("", true), "new1")).toBeNull();
  });
});

describe("authors", () => {
  test("SlopCop is its marker, or a bot named for it", () => {
    expect(
      isSlopCop({ author: "someone", bot: false, body: "x <!-- slopcop:rule=a run=1 -->" }),
    ).toBe(true);
    expect(isSlopCop({ author: "slopcop-dev", bot: true, body: "x" })).toBe(true);
    expect(isSlopCop({ author: "slopcop-fan", bot: false, body: "x" })).toBe(false);
  });

  test("groups run bb, SlopCop, people, bots; findings by priority, then file and line", () => {
    const item = (
      id: string,
      origin: ReviewItem["origin"],
      priority: number | null,
      line: number,
    ): ReviewItem => ({
      id,
      origin,
      priority,
      title: null,
      body: "",
      anchor: { path: "a.ts", line, startLine: null, side: "RIGHT", head: "h" },
      state: "open",
      url: null,
      createdAt: "",
      replies: [],
    });
    const human = { kind: "forge" as const, author: "Octo", bot: false, slopcop: false };
    const groups = groupItems([
      item("g1", { kind: "forge", author: "dependabot", bot: true, slopcop: false }, null, 1),
      item("g2", human, null, 9),
      item("g3", { kind: "forge", author: "slopcop", bot: true, slopcop: true }, null, 1),
      item("b2", { kind: "bb", threadId: "t" }, 2, 1),
      item("b1", { kind: "bb", threadId: "t" }, 0, 7),
      item("g4", human, null, 2),
    ]);
    expect(groups.map((group) => [group.group.label, group.items.map((each) => each.id)])).toEqual([
      ["bb review", ["b1", "b2"]],
      ["SlopCop", ["g3"]],
      ["Octo", ["g4", "g2"]],
      ["dependabot", ["g1"]],
    ]);
  });
});
