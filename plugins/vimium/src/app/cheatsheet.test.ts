import { describe, expect, test } from "bun:test";
import { CHEATSHEET } from "./cheatsheet.ts";
import { DIRECT_SHORTCUTS } from "./direct-shortcuts.ts";
import { RESERVED_CONTROLS } from "./hint-labels.ts";

function keysIn(titles: readonly string[]): string[] {
  return CHEATSHEET.filter((section) => titles.includes(section.title)).flatMap((section) =>
    section.entries.flatMap((entry) => entry.keys),
  );
}

describe("cheatsheet", () => {
  test("lists every direct key exactly once", () => {
    const listed = keysIn(["Navigation", "Composer", "Scrolling"]);
    expect([...listed].sort()).toEqual([...DIRECT_SHORTCUTS.keys()].sort());
  });

  test("lists every pinned hint label", () => {
    const listed = keysIn(["Pinned hint labels"]);
    for (const { char } of RESERVED_CONTROLS) expect(listed).toContain(char);
  });
});
