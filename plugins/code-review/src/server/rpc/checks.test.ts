import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext, fixture } from "../../../test/fake-gh.ts";
import { checks } from "./checks.ts";

test("answers recorded checks in the shared schema", async () => {
  const { ctx } = fakeContext({ graphql: { Checks: fixture("checks-acme-api-1034.json") } });

  const result = (await callProcedure(checks, ctx, {
    account: "octocat",
    ref: { owner: "acme", repo: "api", number: 1034 },
  })) as { state: string; checks: { id: string }[] };

  expect(result.state).toBe("failure");
  expect(result.checks.map((check) => check.id).slice(0, 2)).toEqual([
    "run:110959498696",
    "run:110959498281",
  ]);
});
