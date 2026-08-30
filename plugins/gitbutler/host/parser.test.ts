import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildParsedRepository,
  makeHunkRevisionKey,
  parseBranchNames023,
  parseStatus023,
  parseWorktreeDiff023,
} from "./parser.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../test/fixtures/but-0.22.3/${name}`, import.meta.url), "utf8");

describe("GitButler 0.22.3 parser", () => {
  test("preserves every stack, branch, commit field, file, and hunk without selectors", () => {
    const status = parseStatus023(fixture("status-multiple-stacks.json"));
    const diff = parseWorktreeDiff023(fixture("diff-text-hunks.json"));
    const parsed = buildParsedRepository(status, diff, 123);

    expect(parsed.view.stacks).toHaveLength(2);
    expect(parsed.view.stacks.map((stack) => stack.branches[0]?.branchName)).toEqual([
      "scott/alpha",
      "scott/beta",
    ]);
    expect(parsed.view.stacks[0]?.assignedFiles).toEqual([
      { path: "src/assigned.ts", kind: "modified" },
    ]);
    expect(parsed.view.stacks[0]?.branches[0]?.commits[0]).toMatchObject({
      changeId: "change-a",
      commitId: "1111111111111111111111111111111111111111",
      createdAt: "2026-08-30T00:00:00Z",
      message: "alpha commit",
      author: { name: "Scott", email: "scott@example.com" },
      conflicted: false,
      reviewId: "(#1)",
      files: [{ path: "src/committed.ts", kind: "renamed" }],
    });
    expect(parsed.view.stacks[1]?.branches[0]?.upstreamCommits[0]?.conflicted).toBe(true);
    expect(parsed.view.stacks[0]?.branches[0]?.ci).toEqual({
      status: "inProgress",
      conclusion: "unknown",
      pendingChecks: ["pending"],
      passingChecks: ["passing"],
      failingChecks: ["failing"],
    });
    expect(parsed.view.mergeBase?.message).toBe("base");
    expect(parsed.view.upstream).toEqual({ behind: 2, lastFetched: "2026-08-30T00:01:00Z" });
    expect(parsed.view.worktree.hunkCount).toBe(2);

    const serialized = JSON.stringify(parsed.view);
    expect(serialized).not.toContain("selector-a");
    expect(serialized).not.toContain("cliId");
    expect(serialized).not.toContain("stack-a");
    expect(serialized).not.toContain("branch-a");
  });

  test("derives stable content observations from path and exact hunk patch", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n";
    expect(makeHunkRevisionKey("a.ts", patch)).toBe(makeHunkRevisionKey("a.ts", patch));
    expect(makeHunkRevisionKey("a.ts", `${patch} `)).not.toBe(makeHunkRevisionKey("a.ts", patch));
    expect(makeHunkRevisionKey("b.ts", patch)).not.toBe(makeHunkRevisionKey("a.ts", patch));
  });

  test("keeps unknown diff variants visible and unselectable", () => {
    const status = parseStatus023(fixture("status-multiple-stacks.json"));
    status.uncommittedChanges.push({
      cliId: "asset",
      filePath: "asset.png",
      changeType: "modified",
    });
    const parsed = buildParsedRepository(
      status,
      parseWorktreeDiff023(fixture("diff-unsupported.json")),
    );
    expect(parsed.view.worktree.files.find((file) => file.path === "asset.png")?.content).toEqual({
      kind: "unselectable",
      reason: "binary",
    });
  });

  test("rejects malformed external output", () => {
    expect(() => parseStatus023(fixture("malformed-output.json"))).toThrow(
      /did not match 0\.22\.3/u,
    );
    expect(() => parseWorktreeDiff023("not json")).toThrow(/not valid JSON/u);
  });

  test("reads collision names from applied and unapplied branches", () => {
    expect([...parseBranchNames023(fixture("branch-list.json"))]).toEqual([
      "scott/alpha",
      "scott/existing",
    ]);
  });
});
