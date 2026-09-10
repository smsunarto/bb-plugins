import { describe, expect, test } from "bun:test";
import { applyPatch, parsePatch } from "diff";
import { buildDiff } from "./diff.ts";

describe("SDK diff input", () => {
  test.each([
    ["modified", "before\n", "after\n"],
    ["new file", null, "new\n"],
    ["empty new file", null, ""],
    ["emptied file", "before\n", ""],
    ["missing final newline", "before", "after"],
    ["CRLF", "before\r\nnext\r\n", "after\r\nnext\r\n"],
  ] as const)("preserves %s contents in a single-file patch", (_, before, after) => {
    const result = buildDiff("config file.ini", before, after);
    expect(result).not.toBeNull();
    expect(parsePatch(result!.patch)).toHaveLength(1);
    expect(applyPatch(before ?? "", result!.patch)).toBe(after);
    expect(result!.experimental_fullFileContents).toEqual({
      old: { path: before === null ? "/dev/null" : "config file.ini", content: before ?? "" },
      new: { path: "config file.ini", content: after },
    });
  });

  test("provides complete contents for expanding unchanged context", () => {
    const before = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
    const after = before.replace("line 50\n", "updated\n");
    const result = buildDiff("config.ini", before, after)!;
    expect(result.patch).not.toContain("line 0\n");
    expect(applyPatch(before, result.patch)).toBe(after);
    expect(result.experimental_fullFileContents?.old.content).toBe(before);
    expect(result.experimental_fullFileContents?.new.content).toBe(after);
  });

  test.each(["", "same\n", "same"])("uses the source viewer for unchanged text %j", (content) => {
    expect(buildDiff("config.ini", content, content)).toBeNull();
  });
});
