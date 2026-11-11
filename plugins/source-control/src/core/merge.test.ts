import { describe, expect, test } from "vitest";
import { initialMethod, mergeIssue, type MergePolicy } from "./merge.ts";

const POLICY: MergePolicy = {
  state: "OPEN",
  isDraft: false,
  headRefOid: "c0ffee",
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  canMerge: true,
  methods: ["merge", "squash", "rebase"],
};
const issue = (policy: Partial<MergePolicy>, method: "merge" | "squash" | "rebase" = "squash") =>
  mergeIssue({ policy: { ...POLICY, ...policy }, head: "c0ffee", base: "main", method });

describe("mergeIssue", () => {
  test("a clean, open, ready pull request at the seen head and base can merge", () => {
    expect(issue({})).toBeNull();
    expect(issue({ mergeStateStatus: "HAS_HOOKS" })).toBeNull();
    expect(issue({ mergeStateStatus: "UNSTABLE" })).toBeNull();
  });

  test("each unmet requirement names itself, in code-review's order", () => {
    expect(issue({ state: "MERGED" })).toBe("This pull request is already merged.");
    expect(issue({ state: "CLOSED" })).toBe(
      "The pull request state changed. Refresh before trying again.",
    );
    expect(issue({ canMerge: false })).toBe("This account cannot merge this pull request.");
    expect(issue({ headRefOid: "f00d" })).toBe(
      "The branch changed. Review the latest commit before merging.",
    );
    expect(issue({ baseRefName: "release" })).toBe(
      "The destination branch changed. Refresh before merging.",
    );
    expect(issue({ isDraft: true })).toBe("Mark the pull request ready before merging.");
    expect(issue({ mergeStateStatus: "BEHIND" })).toContain("GitHub blocks merging: BEHIND");
    expect(issue({ mergeStateStatus: "UNKNOWN" })).toContain("GitHub blocks merging: UNKNOWN");
    expect(issue({ methods: ["merge"] })).toBe("This repository does not allow that merge method.");
  });
});

test("the dialog starts on the reader's choice when allowed, else the first allowed", () => {
  expect(initialMethod(["merge", "squash"], "squash")).toBe("squash");
  expect(initialMethod(["rebase"], "squash")).toBe("rebase");
  expect(initialMethod([], "squash")).toBe("squash");
});
