import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCurrentBranchNotInStack,
  partialSuccessWarning,
  requiresAgentSyncRecovery,
} from "../lib/gh-stack-output.ts";

test("only the exact current-branch error is classified as not in a stack", () => {
  assert.equal(
    isCurrentBranchNotInStack(
      2,
      'current branch "feature/cache" is not part of a stack\n',
    ),
    true,
  );
  assert.equal(isCurrentBranchNotInStack(2, "not a git repository\n"), false);
  assert.equal(
    isCurrentBranchNotInStack(2, "failed to load stack state: invalid JSON\n"),
    false,
  );
  assert.equal(
    isCurrentBranchNotInStack(
      6,
      'current branch "main" is not part of a stack\n',
    ),
    false,
  );
});

test("sync exit-zero warning output is treated as incomplete", () => {
  assert.match(
    partialSuccessWarning("sync", "Sync aborted — no changes were made", "") ?? "",
    /aborted/i,
  );
  assert.match(
    partialSuccessWarning(
      "sync",
      "Push failed — branches may need force push after rebase\nStack synced",
      "",
    ) ?? "",
    /not pushed/i,
  );
  assert.match(
    partialSuccessWarning("sync", "Branches synced", "Failed to update stack on GitHub") ??
      "",
    /could not update/i,
  );
  assert.match(
    partialSuccessWarning(
      "sync",
      "Could not resolve branch SHAs — skipping rebase: API error\nBranches synced",
      "",
    ) ?? "",
    /skipped a required rebase/i,
  );
});

test("submit exit-zero PR failures are treated as incomplete", () => {
  assert.match(
    partialSuccessWarning(
      "submit",
      "failed to create PR for feature/cache: API error\nPushed and synced 2 branches",
      "",
    ) ?? "",
    /partially/i,
  );
  assert.match(
    partialSuccessWarning("submit", "Cannot create stack: invalid PR chain", "") ?? "",
    /could not update/i,
  );
  const incompleteWarnings = [
    'PR #12 has base "main" (expected "feature-one") but cannot update while stacked',
    "failed to disable auto-merge for PR #12: API error",
    "Your PRs belong to multiple stacks on GitHub — reconcile them first",
    "The stack on GitHub differs from your local stack and couldn't be updated automatically",
    "Could not create stack: API error",
  ];
  for (const warning of incompleteWarnings) {
    assert.notEqual(
      partialSuccessWarning("submit", warning, ""),
      null,
      `warning was treated as success: ${warning}`,
    );
  }
  assert.equal(
    partialSuccessWarning("submit", "Pushed and synced 2 branches", ""),
    null,
  );
  assert.equal(
    partialSuccessWarning("submit", "Disabled auto-merge for PR #12", ""),
    null,
  );
});

test("only recoverable sync states request an agent", () => {
  const recoverable: Array<[number, string]> = [
    [3, "rebase conflict"],
    [7, "rebase already in progress"],
    [0, "Sync aborted — no changes were made"],
    [0, "sync aborted"],
    [0, "Your local stack has diverged from the stack on GitHub"],
    [0, 'PR #12 has base "main" (expected "feature-one") but cannot update while stacked'],
    [0, "Your PRs belong to multiple stacks on GitHub — reconcile them first"],
    [0, "The stack on GitHub differs from your local stack and couldn't be updated automatically"],
    [0, "Cannot create stack: invalid PR chain"],
  ];
  for (const [code, output] of recoverable) {
    assert.equal(
      requiresAgentSyncRecovery(code, output),
      true,
      `recoverable state was not delegated: ${output}`,
    );
  }

  const ordinaryFailures: Array<[number, string]> = [
    [1, "Sync aborted because authentication failed"],
    [1, "Push failed — branches may need force push after rebase\nStack synced"],
    [1, "Failed to update stack on GitHub: API error"],
    [1, "Could not create stack: API error"],
    [4, "GitHub API failure"],
    [6, "branch belongs to multiple stacks"],
    [8, "stack file locked"],
    [9, "stacked PRs are not enabled"],
    [10, "modify recovery required"],
  ];
  for (const [code, output] of ordinaryFailures) {
    assert.equal(
      requiresAgentSyncRecovery(code, output),
      false,
      `ordinary failure was delegated: ${output}`,
    );
  }

  assert.equal(
    partialSuccessWarning("sync", "Sync aborted because authentication failed", ""),
    null,
  );
});
