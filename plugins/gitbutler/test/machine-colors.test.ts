import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("matches GTD Sidebar's machine colors byte for byte", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  expect(read("../src/app/machine-colors.ts")).toBe(
    read("../../gtd-sidebar/lib/machine-colors.ts"),
  );
});
