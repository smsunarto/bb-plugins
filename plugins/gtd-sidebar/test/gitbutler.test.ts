import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  gitButlerBranchNamesFor,
  gitButlerLabelsMatch,
  parseGitButlerBranchSummary,
  resolveSidebarBranchLabel,
} from "../lib/gitbutler.ts";

describe("gitButlerLabelsMatch", () => {
  it("matches identical labels regardless of insertion order", () => {
    const current = new Map([
      ["env_1", "scott/api"],
      ["env_2", "scott/ui"],
    ]);
    assert.equal(gitButlerLabelsMatch(current, new Map([...current].reverse())), true);
    assert.equal(gitButlerLabelsMatch(current, current), true);
    assert.equal(gitButlerLabelsMatch(new Map(), new Map()), true);
  });

  it("detects changed labels and replaced environments", () => {
    const current = new Map([["env_1", "scott/api"]]);
    assert.equal(gitButlerLabelsMatch(current, new Map([["env_1", "scott/ui"]])), false);
    assert.equal(gitButlerLabelsMatch(current, new Map([["env_2", "scott/api"]])), false);
  });

  it("detects added and removed labels, including a cleared map", () => {
    const current = new Map([["env_1", "scott/api"]]);
    const expanded = new Map([...current, ["env_2", "scott/ui"]]);
    assert.equal(gitButlerLabelsMatch(current, expanded), false);
    assert.equal(gitButlerLabelsMatch(expanded, current), false);
    assert.equal(gitButlerLabelsMatch(current, new Map()), false);
    assert.equal(gitButlerLabelsMatch(new Map(), current), false);
  });
});

describe("parseGitButlerBranchSummary", () => {
  it("uses the real name when one virtual branch is applied", () => {
    assert.deepEqual(
      parseGitButlerBranchSummary(
        JSON.stringify({
          stacks: [{ branches: [{ name: "scott/show-gitbutler-branch" }] }],
        }),
      ),
      {
        label: "scott/show-gitbutler-branch",
        branchNames: ["scott/show-gitbutler-branch"],
      },
    );
  });

  it("reports an honest count when several branches are applied", () => {
    assert.deepEqual(
      parseGitButlerBranchSummary(
        JSON.stringify({
          stacks: [
            { branches: [{ name: "scott/api" }, { name: "scott/ui" }] },
            { branches: [{ name: "scott/docs" }] },
          ],
        }),
      ),
      {
        label: "3 GitButler branches",
        branchNames: ["scott/api", "scott/ui", "scott/docs"],
      },
    );
  });

  it("rejects malformed and branchless status output", () => {
    assert.equal(parseGitButlerBranchSummary("not json"), null);
    assert.equal(parseGitButlerBranchSummary(JSON.stringify({ stacks: [] })), null);
    assert.equal(
      parseGitButlerBranchSummary(JSON.stringify({ stacks: [{ branches: [{ name: " " }] }] })),
      null,
    );
  });
});

describe("resolveSidebarBranchLabel", () => {
  const labels = new Map([["env_local", "scott/show-gitbutler-branch"]]);

  it("replaces GitButler's synthetic workspace branch", () => {
    assert.equal(
      resolveSidebarBranchLabel("gitbutler/workspace", "env_local", labels),
      "scott/show-gitbutler-branch",
    );
  });

  it("replaces stale branch metadata after a checkout adopts GitButler", () => {
    assert.equal(
      resolveSidebarBranchLabel("old-local-branch", "env_local", labels),
      "scott/show-gitbutler-branch",
    );
  });

  it("keeps the workspace label until the host probe resolves", () => {
    assert.equal(
      resolveSidebarBranchLabel("gitbutler/workspace", "env_unknown", labels),
      "gitbutler/workspace",
    );
  });
});

describe("gitButlerBranchNamesFor", () => {
  it("uses the host's virtual branch names, not the count label", () => {
    const branches = new Map([["env_local", ["scott/api", "scott/ui", "scott/docs"]]]);
    assert.deepEqual(
      gitButlerBranchNamesFor("gitbutler/workspace", "env_local", branches),
      ["scott/api", "scott/ui", "scott/docs"],
    );
    assert.deepEqual(
      gitButlerBranchNamesFor("3 GitButler branches", "env_local", branches),
      ["scott/api", "scott/ui", "scott/docs"],
    );
  });

  it("drops GitButler workspace refs when the host has not answered", () => {
    assert.deepEqual(
      gitButlerBranchNamesFor("gitbutler/workspace", "env_unknown", new Map()),
      [],
    );
    assert.deepEqual(gitButlerBranchNamesFor("3 GitButler branches", "env_x", new Map()), []);
  });

  it("keeps a real git branch when GitButler is not in play", () => {
    assert.deepEqual(gitButlerBranchNamesFor("feat/ship", "env_x", new Map()), ["feat/ship"]);
  });
});
