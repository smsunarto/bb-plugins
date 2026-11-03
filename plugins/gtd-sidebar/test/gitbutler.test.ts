import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGitButlerBranchSummary, resolveSidebarBranchLabel } from "../lib/gitbutler.ts";

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
