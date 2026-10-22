import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { UNPUBLISHED, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import { branchId } from "../lib/gitbutler.ts";
import plugin from "../server.ts";

test("the share tool returns valid branch and PR cards, refuses missing or ambiguous branches", async () => {
  let branches = UNPUBLISHED.branches;
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: { plugins: fakeGitButler({ unpublishedBranches: () => ({ branches }) }) },
  });
  await plugin(bb);
  const branch = UNPUBLISHED.branches[1]!;
  const id = branchId(branch.hostId, branch.path, branch.branch);
  expect(
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch },
    }),
  ).toBe(`::code-review{branch="${id}" base="${branch.base}" head="${branch.head}"}`);
  expect(
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "pr", reference: "https://github.com/acme/api/pull/42", account: "scott" },
    }),
  ).toBe('::code-review{pr="acme/api#42" account="scott"}');
  await expect(
    harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: "missing" },
    }),
  ).rejects.toThrow("No unpublished branch");
  await expect(
    harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "pr", reference: "javascript:alert(1)" },
    }),
  ).rejects.toThrow("GitHub pull request");
  branches = [branch, { ...branch, hostId: "other-host" }];
  await expect(
    harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch },
    }),
  ).rejects.toThrow("Several checkouts match");
  expect(
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch, hostId: branch.hostId },
    }),
  ).toContain(`branch="${id}"`);
  await harness.lifecycle.dispose();
});
