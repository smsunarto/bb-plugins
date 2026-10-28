import { expect, test } from "bun:test";
import { fakeContext, fixture } from "../../../test/fake-gh.ts";
import { checks, checksContract } from "./checks.ts";

test("answers recorded checks in the shared schema", async () => {
  const { ctx } = fakeContext({ graphql: { Checks: fixture("checks-acme-api-1034.json") } });

  const result = checksContract.output.parse(
    await checks(ctx, { account: "octocat", ref: { owner: "acme", repo: "api", number: 1034 } }),
  );

  expect(result.state).toBe("failure");
  expect(result.checks.map((check) => check.id).slice(0, 2)).toEqual([
    "run:110959498696",
    "run:110959498281",
  ]);
});
