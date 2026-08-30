import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CommitIntent } from "../shared/domain.ts";
import type { FixedButCommands } from "./commands.ts";
import { RepositoryMutationQueue } from "./mutation-queue.ts";
import { buildParsedRepository, parseStatus023, parseWorktreeDiff023 } from "./parser.ts";
import { createGitButlerHostService } from "./service.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../test/fixtures/but-0.22.3/${name}`, import.meta.url), "utf8");

function harness(
  options: {
    readonly branchNames?: ReadonlySet<string>;
    readonly changeOnCommit?: boolean;
    readonly commitDelayMs?: number;
  } = {},
) {
  let status = parseStatus023(fixture("status-multiple-stacks.json"));
  let diff = parseWorktreeDiff023(fixture("diff-text-hunks.json"));
  const initial = buildParsedRepository(status, diff, 1);
  const key = initial.view.worktree.files[0]?.content;
  if (key?.kind !== "text" || key.hunks[0] === undefined) throw new Error("fixture hunk missing");
  const hunkKey = key.hunks[0].revisionKey;
  let commitCalls = 0;
  let activeCommits = 0;
  let maxActiveCommits = 0;
  const commands: FixedButCommands = {
    async version() {
      return "0.22.3";
    },
    async status() {
      return structuredClone(status);
    },
    async worktreeDiff() {
      return structuredClone(diff);
    },
    async branchNames() {
      return options.branchNames ?? new Set();
    },
    async commit(_cwd, input) {
      commitCalls += 1;
      activeCommits += 1;
      maxActiveCommits = Math.max(maxActiveCommits, activeCommits);
      if ((options.commitDelayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.commitDelayMs));
      }
      activeCommits -= 1;
      if (options.changeOnCommit === false) return;
      expect(input.hunks.map(String)).toEqual(["selector-a"]);
      status = structuredClone(status);
      diff = structuredClone(diff);
      status.uncommittedChanges = status.uncommittedChanges.filter(
        (change) => change.filePath !== "src/a.ts",
      );
      diff.changes = diff.changes.filter((change) => change.path !== "src/a.ts");
      status.stacks[0]?.branches[0]?.commits.unshift({
        cliId: "fresh-commit-selector",
        changeId: "fresh-change",
        commitId: "3333333333333333333333333333333333333333",
        createdAt: "2026-08-30T00:02:00Z",
        message: input.message,
        authorName: "Scott",
        authorEmail: "scott@example.com",
        conflicted: false,
        reviewId: null,
        changes: [{ cliId: "fresh-file", filePath: "src/a.ts", changeType: "modified" }],
      });
    },
  };
  return {
    hunkKey,
    service: createGitButlerHostService({
      commands,
      mutations: new RepositoryMutationQueue(),
      realpath: async () => "/canonical/repo",
    }),
    counts: () => ({ commitCalls, maxActiveCommits }),
  };
}

function intent(
  hunkKey: string,
  target: CommitIntent["target"] = { kind: "existing", branchName: "scott/alpha" },
): CommitIntent {
  return { message: "test commit", target, hunkKeys: [hunkKey] };
}

describe("host commit transaction", () => {
  test("freshly remaps one hunk selector and proves the commit", async () => {
    const testHarness = harness();
    const result = await testHarness.service.commitSelection(
      "/repo",
      intent(testHarness.hunkKey),
      new AbortController().signal,
    );
    expect(result.outcome).toEqual({
      kind: "committed",
      branchName: "scott/alpha",
      commitId: "3333333333333333333333333333333333333333",
      committedHunkCount: 1,
    });
    expect(testHarness.counts().commitCalls).toBe(1);
  });

  test("serializes duplicate submissions so the second becomes stale before commit", async () => {
    const testHarness = harness({ commitDelayMs: 10 });
    const input = intent(testHarness.hunkKey);
    const [first, second] = await Promise.all([
      testHarness.service.commitSelection("/first-alias", input, new AbortController().signal),
      testHarness.service.commitSelection("/second-alias", input, new AbortController().signal),
    ]);
    expect(first.outcome.kind).toBe("committed");
    expect(second.outcome).toMatchObject({ kind: "rejected", code: "selection-stale" });
    expect(testHarness.counts()).toEqual({ commitCalls: 1, maxActiveCommits: 1 });
  });

  test("rejects a new-branch collision without running commit", async () => {
    const testHarness = harness({ branchNames: new Set(["scott/existing"]) });
    const result = await testHarness.service.commitSelection(
      "/repo",
      intent(testHarness.hunkKey, { kind: "new", branchName: "scott/existing" }),
      new AbortController().signal,
    );
    expect(result.outcome).toMatchObject({ kind: "rejected", code: "branch-name-taken" });
    expect(testHarness.counts().commitCalls).toBe(0);
  });

  test("reports uncertainty when a successful command has unproven postconditions", async () => {
    const testHarness = harness({ changeOnCommit: false });
    const result = await testHarness.service.commitSelection(
      "/repo",
      intent(testHarness.hunkKey),
      new AbortController().signal,
    );
    expect(result.outcome).toMatchObject({ kind: "uncertain", code: "postcondition-failed" });
    expect(testHarness.counts().commitCalls).toBe(1);
  });
});
