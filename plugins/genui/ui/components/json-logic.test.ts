import { describe, expect, it } from "vitest";
import type { Value } from "../../core/types";
import { CHILD_PAGE, childPath, copyText, defaultOpen, sizeText, visibleRows, type JsonRow } from "./json-logic";

const outline = (rows: readonly JsonRow[]) =>
  rows.map((row) => (row.type === "more" ? `${"  ".repeat(row.depth)}… ${row.remaining} more` : `${"  ".repeat(row.depth)}${row.id}`));

describe("childPath", () => {
  it("writes JSONPath, bracketing keys that are not identifiers", () => {
    expect(childPath(childPath(childPath("$", "items"), 3), "name")).toBe("$.items[3].name");
    expect(childPath("$", "two words")).toBe('$["two words"]');
    expect(childPath("$", 'say "hi"')).toBe('$["say \\"hi\\""]');
    expect(childPath("$", "$ref")).toBe("$.$ref");
  });
});

describe("visibleRows", () => {
  const value: Value = { id: 7, user: { name: "Ada", tags: ["a", "b"] }, items: [1, 2] };

  it("shows a container root's entries as the top level and only open containers' children", () => {
    const open = new Set(["$.user"]);
    expect(outline(visibleRows(value, (id) => open.has(id), () => CHILD_PAGE))).toEqual([
      "$.id",
      "$.user",
      "  $.user.name",
      "  $.user.tags",
      "$.items",
    ]);
    const [, user, name] = visibleRows(value, (id) => open.has(id), () => CHILD_PAGE);
    expect(user).toMatchObject({ parent: null, position: 2, siblings: 3, kind: "object" });
    expect(name).toMatchObject({ parent: "$.user", depth: 1, key: "name", value: "Ada" });
  });

  it("pages long containers with a row for the rest", () => {
    const long = Array.from({ length: 250 }, (_, i) => i);
    const rows = visibleRows({ long }, () => true, (id) => (id === "$.long" ? 3 : CHILD_PAGE));
    expect(outline(rows)).toEqual(["$.long", "  $.long[0]", "  $.long[1]", "  $.long[2]", "  … 247 more"]);
    expect(rows[4]).toMatchObject({ type: "more", parent: "$.long", shown: 3 });
  });

  it("shows a scalar root as one row and stays iterative for deep values", () => {
    expect(visibleRows("hi", () => true, () => CHILD_PAGE)).toEqual([
      { type: "value", id: "$", depth: 0, key: null, value: "hi", kind: "string", parent: null, position: 1, siblings: 1, children: 0 },
    ]);
    let deep: Value = 0;
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(visibleRows(deep, () => true, () => CHILD_PAGE)).toHaveLength(20_000);
  });
});

describe("defaultOpen", () => {
  it("opens a chain of lone containers under the root, so envelopes show their content", () => {
    expect([...defaultOpen({ data: { user: { name: "Ada", tags: [] } } })]).toEqual(["$.data", "$.data.user"]);
    expect([...defaultOpen({ data: [1], meta: {} })]).toEqual([]);
    expect([...defaultOpen([{ id: 1 }])]).toEqual(["$[0]"]);
  });

  it("never lets an empty container expand", () => {
    const [empty] = visibleRows({ none: [] }, () => true, () => CHILD_PAGE);
    expect(empty).toMatchObject({ id: "$.none", children: 0 });
  });
});

describe("sizeText and copyText", () => {
  it("counts keys and items, and copies strings bare and containers as JSON", () => {
    expect([sizeText({ a: 1 }), sizeText([]), sizeText([1, 2]), sizeText("x")]).toEqual(["1 key", "0 items", "2 items", ""]);
    expect([copyText("plain"), copyText(3), copyText(null), copyText([1])]).toEqual(["plain", "3", "null", "[\n  1\n]"]);
  });
});
