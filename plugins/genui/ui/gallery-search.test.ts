import { describe, expect, it } from "vitest";
import { COMPONENTS, type ComponentName } from "../core/catalog";
import { GALLERY_ORDER, searchComponents } from "./gallery-search";

const names = (query: string, variants?: ReadonlyMap<ComponentName, readonly string[]>) =>
  searchComponents(query, variants).map((match) => match.name);

describe("gallery search", () => {
  it("lists every catalog component exactly once", () => {
    expect([...GALLERY_ORDER].sort()).toEqual(Object.keys(COMPONENTS).sort());
  });

  it("puts names that start with the query first, then names that contain it, ignoring case", () => {
    const found = searchComponents("ta");
    expect(found.slice(0, 2)).toEqual([
      { name: "Tabs", kind: "prefix", at: 0 },
      { name: "Table", kind: "prefix", at: 0 },
    ]);
    expect(found.find((match) => match.name === "StackTrace")).toEqual({ name: "StackTrace", kind: "name", at: 1 });
    expect(names("LOGS")[0]).toBe("Logs");
  });

  it("finds a group by name, and a component by what it shows or by an example's variant", () => {
    const dev = searchComponents("dev");
    expect(dev.filter((match) => match.kind === "group").map((match) => match.name)).toEqual(
      GALLERY_ORDER.filter((name) => COMPONENTS[name].group === "Dev"),
    );
    expect(names("kanban")).toEqual(["Board"]);
    expect(names("no-receipt", new Map([["Provenance", ["deploy", "no-receipt"]]]))).toEqual(["Provenance"]);
  });

  it("finds nothing for a blank query or one nothing matches", () => {
    expect(searchComponents("   ")).toEqual([]);
    expect(searchComponents("zzzz")).toEqual([]);
  });
});
