import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import {
  type FakeGhRoutes,
  GhFailure,
  fakeContext,
  fixture,
  fixtureText,
} from "../../../test/fake-gh.ts";
import { fixChecksPrompt } from "./fix-checks-prompt.ts";

const REF = { owner: "acme", repo: "api", number: 1034 };
const HEAD = {
  repository: {
    pullRequest: {
      number: 1034,
      title: "chore: remove an unused decoder",
      url: "https://github.com/acme/api/pull/1034",
      headRefName: "chore/remove-unused-decoder",
      baseRefName: "main",
      headRefOid: "423b69654005c318d92687f191a3b8f473043c25",
      baseRefOid: "1f47a0690cc0c17564dbbfb8959e16488411bc4a",
      isCrossRepository: false,
    },
  },
};

function context(logs: FakeGhRoutes["rest"], projects: unknown[] = []) {
  return fakeContext(
    {
      graphql: { PullRequestHead: HEAD, Checks: fixture("checks-acme-api-1034.json") },
      rest: logs,
    },
    { projects: { list: async () => projects } },
  );
}

test("fills the prompt with each selected failure and the end of its job log", async () => {
  const { ctx, calls } = context(
    {
      "repos/acme/api/actions/jobs/110959498696/logs": fixtureText("job-log.txt"),
      "repos/acme/api/actions/jobs/110959498281/logs": () => {
        throw new GhFailure("gh: HTTP 410: Gone");
      },
    },
    [
      {
        id: "p-api",
        gitRemoteUrl: "git@github.com:acme/api.git",
        sources: [{ hostId: "host-1", path: "/src/api", isDefault: true }],
      },
    ],
  );

  const { prompt, projectId, environment } = (await callProcedure(fixChecksPrompt, ctx, {
    ref: REF,
    checkIds: ["run:110959498696", "run:110959498281", "run:110960956479", "run:gone"],
  })) as { prompt: string; projectId: string | null; environment: unknown };

  expect(projectId).toBe("p-api");
  // A fresh worktree, so the fix never switches branches in the user's checkout.
  expect(environment).toEqual({
    type: "host",
    hostId: "host-1",
    workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
  });
  expect(calls.filter((call) => call.kind === "rest").map((call) => call.path)).toEqual([
    "repos/acme/api/actions/jobs/110959498696/logs",
    "repos/acme/api/actions/jobs/110959498281/logs",
  ]);
  expect(prompt).toStartWith(
    "Fix the failing checks on pull request acme/api#1034: chore: remove an unused decoder",
  );
  expect(prompt).toContain(
    "### CI / Lint\n\nhttps://github.com/acme/api/actions/runs/37043618707/job/110959498696\n\n```text\n",
  );
  expect(prompt).toContain("##[error]Process completed with exit code 201.\n```");
  expect(prompt).toContain(
    "### CI / Test\n\nhttps://github.com/acme/api/actions/runs/37043618707/job/110959498281\n\nNo log: HTTP 410: Gone",
  );
  expect(prompt).toContain(
    "### CI / Qodana for Go\n\nhttps://github.com/acme/api/runs/110960956479\n\n1637 new problems found by Qodana for Go\n\nNo log: the check is neutral.",
  );
});

test("fetches at most three logs, and has no project for a repository bb does not know", async () => {
  type Rollup = { contexts: { nodes: { conclusion?: string }[] } };
  const data = fixture<{
    repository: {
      pullRequest: { commits: { nodes: { commit: { statusCheckRollup: Rollup } }[] } };
    };
  }>("checks-acme-api-1034.json");
  for (const node of data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup.contexts
    .nodes) {
    node.conclusion = "FAILURE";
  }
  const jobs = ["110959498696", "110959498281", "110959522353", "110959498726"];
  const { ctx, calls } = fakeContext(
    {
      graphql: { PullRequestHead: HEAD, Checks: data },
      rest: Object.fromEntries(
        jobs.map((id) => [`repos/acme/api/actions/jobs/${id}/logs`, "##[error]failed"]),
      ),
    },
    { projects: { list: async () => [] } },
  );

  const result = (await callProcedure(fixChecksPrompt, ctx, {
    ref: REF,
    checkIds: jobs.map((id) => `run:${id}`),
  })) as { prompt: string; projectId: string | null; environment: unknown };

  expect(result.projectId).toBeNull();
  expect(result.environment).toBeNull();
  expect(calls.filter((call) => call.kind === "rest")).toHaveLength(3);
  expect(result.prompt.match(/No log: not fetched; open the URL\./g)).toHaveLength(1);
});

test("checks that are gone from the head commit are refused", async () => {
  const { ctx } = context({});
  await expect(
    callProcedure(fixChecksPrompt, ctx, { ref: REF, checkIds: ["run:1"] }),
  ).rejects.toThrow("Those checks are no longer on the latest commit. Refresh and try again.");
});
