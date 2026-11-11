import { describe, expect, test } from "vitest";
import { expandDirectories } from "./guides.ts";

const PATHS = ["src/a/one.ts", "src/a/two.ts", "src/b.ts", "README.md", "pnpm-lock.yaml"];
const group = (title: string, ...paths: string[]) => ({
  title,
  intro: "",
  files: paths.map((path) => ({ path })),
});
const shape = (placed: ReturnType<typeof expandDirectories>["placed"]) =>
  placed.map((each) => `${each.title}: ${each.files.map((file) => file.path).join(", ")}`);

describe("expandDirectories", () => {
  test("a directory places its files in path order, except those named on their own", () => {
    const { placed, unknown } = expandDirectories(
      [group("Core", "src/"), group("Two first", "src/a/two.ts"), group("Root", "./")],
      PATHS,
    );
    expect(unknown).toEqual([]);
    expect(shape(placed)).toEqual([
      "Core: src/a/one.ts, src/b.ts",
      "Two first: src/a/two.ts",
      "Root: README.md, pnpm-lock.yaml",
    ]);
  });

  test("a path or directory outside the change is refused; a file named twice is placed once", () => {
    const { placed, unknown } = expandDirectories(
      [group("A", "src/b.ts", "lib/", "nope.ts"), group("B", "src/b.ts")],
      PATHS,
    );
    expect(unknown).toEqual(["lib/", "nope.ts"]);
    expect(shape(placed)).toEqual(["A: src/b.ts", "B: "]);
  });
});
