import { expect, test } from "bun:test";
import { fingerprint, newErrors } from "./lint";

test("the lint gate rejects new errors and duplicate occurrences", () => {
  expect(newErrors(["known", "new"], ["known"])).toEqual(["new"]);
  expect(newErrors(["known", "known"], ["known"])).toEqual(["known"]);
  expect(newErrors([], ["resolved"])).toEqual([]);
});

test("lint fingerprints survive line shifts but distinguish source and rule changes", () => {
  const diagnostic = { filename: "a.ts", code: "no-unused-vars", message: "Unused variable" };
  const id = fingerprint(diagnostic, "  const unused = 1;");
  expect(fingerprint(diagnostic, "const unused = 1;")).toBe(id);
  expect(fingerprint(diagnostic, "const another = 1;")).not.toBe(id);
  expect(fingerprint({ ...diagnostic, code: "another-rule" }, "const unused = 1;")).not.toBe(id);
});
