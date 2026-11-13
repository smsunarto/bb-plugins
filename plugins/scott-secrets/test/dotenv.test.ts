import { expect, test } from "bun:test";
import { reconcileDotenv } from "../src/shared/dotenv.ts";

test("rewrites in place, keeps export and trailing comments, appends new names", () => {
  const before = "export A=\"old\" # keep me\nB=x#not-a-comment\nC='q # inside'\n";
  const result = reconcileDotenv(before, { A: "new", B: "y", D: "it's" });
  expect(result.content).toBe("export A='new' # keep me\nB='y'\nC='q # inside'\nD=\"it's\"\n");
  expect(result).toMatchObject({ added: 1, updated: 2, unchanged: 0 });
});

test("refuses duplicates and multiline quoted values", () => {
  expect(() => reconcileDotenv("A=1\nA=2\n", { A: "x" })).toThrow("duplicate");
  expect(() => reconcileDotenv('A="line\n', { A: "x" })).toThrow("multiline");
});
