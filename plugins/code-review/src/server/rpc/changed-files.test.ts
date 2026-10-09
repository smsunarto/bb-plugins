import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext, fixture, fixtureText } from "../../../test/fake-gh.ts";
import { changedFiles } from "./changed-files.ts";

test("answers recorded changed files in the shared schema", async () => {
  const recorded = fixture<{ repository: { pullRequest: object } }>("changed-files-cli-9000.json");
  const { ctx } = fakeContext({
    graphql: {
      // The recording predates reading the base.
      ChangedFiles: {
        repository: { pullRequest: { ...recorded.repository.pullRequest, baseRefName: "trunk" } },
      },
      PullRequestHead: {
        repository: {
          pullRequest: {
            headRefOid: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
            baseRefName: "trunk",
          },
        },
      },
    },
    rest: {
      "repos/cli/cli/pulls/9000/files?per_page=100": fixtureText("rest-files-cli-9000.ndjson"),
    },
  });

  const result = (await callProcedure(changedFiles, ctx, {
    ref: { owner: "cli", repo: "cli", number: 9000 },
  })) as { baseRefName: string; files: { path: string }[] };

  expect(result.baseRefName).toBe("trunk");
  expect(result.files.map((file) => file.path)).toEqual([
    "pkg/cmd/attestation/verify/verify.go",
    "pkg/cmd/attestation/verify/verify_test.go",
    "pkg/cmdutil/auth_check.go",
    "pkg/cmdutil/auth_check_test.go",
  ]);
});
