import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGitButlerBranchSummary } from "../lib/gitbutler.ts";

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
