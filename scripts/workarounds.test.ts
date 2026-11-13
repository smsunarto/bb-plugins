import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probe, readRegistry, scanMarkers, stripBlocks, type Workaround } from "./workarounds.ts";

const root = resolve(import.meta.dir, "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => file && existsSync(join(root, file)));
const markers = scanMarkers(files, (file) => readFileSync(join(root, file), "utf8"));
const { workarounds } = readRegistry();
const ids = new Set(workarounds.map((entry) => entry.id));

test("every workaround comment names a registered workaround", () => {
  expect(markers.filter((marker) => !ids.has(marker.id))).toEqual([]);
});

test("every workaround can be found: files that exist, fenced blocks, or a manual tag", () => {
  for (const entry of workarounds) {
    for (const file of entry.files ?? []) expect(existsSync(join(root, file))).toBe(true);
    const own = markers.filter((marker) => marker.id === entry.id);
    if (entry.manual) expect(own.some((marker) => marker.kind === "tag")).toBe(true);
    else expect((entry.files ?? []).length + own.length).toBeGreaterThan(0);
  }
});

test("fences are balanced in every file", () => {
  for (const file of new Set(markers.map((marker) => marker.file))) {
    const text = readFileSync(join(root, file), "utf8");
    for (const id of new Set(markers.filter((m) => m.file === file).map((m) => m.id)))
      expect(() => stripBlocks(text, id)).not.toThrow();
  }
});

test("stripping removes a block and its fences, leaving one blank line", () => {
  const text = ["a", "", "// workaround:x begin", "b", "// workaround:x end", "", "c"].join("\n");
  expect(stripBlocks(text, "x")).toBe("a\n\nc");
  expect(stripBlocks(text, "y")).toBe(text);
});

test("a probe reports fixed only on a positive sign of the fix", () => {
  const entry = { probe: { needed: "oldBug", fixed: "newFix" } } as Workaround;
  expect(probe(entry, "newFix oldBug")).toBe("fixed");
  expect(probe(entry, "oldBug")).toBe("needed");
  expect(probe(entry, "renamed by the minifier")).toBe("unknown");
});
