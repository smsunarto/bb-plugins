import { expect, test } from "bun:test";
import { RPCValidationError, callProcedure } from "@bb-kit/core/rpc";
import { fakeContext, fixture } from "../../../test/fake-gh.ts";
import { pullRequest } from "./pull-request.ts";

test("answers a recorded pull request in the shared schema", async () => {
  const { ctx } = fakeContext({
    graphql: {
      PullRequest: fixture("pull-request-cli-14572.json"),
      Stack: fixture("stack-cli-14572.json"),
    },
  });

  const pr = (await callProcedure(pullRequest, ctx, {
    ref: { owner: "cli", repo: "cli", number: 14572 },
  })) as { title: string; stack: { parent: { number: number } | null } };

  expect(pr.title).toBe(
    "`gh issue artifact` stack 9/11: Document `gh issue artifact` in the `gh` skill",
  );
  expect(pr.stack.parent?.number).toBe(14571);
});

test("rejects a reference that is not a pull request", async () => {
  const { ctx } = fakeContext();
  await expect(
    callProcedure(pullRequest, ctx, { ref: { owner: "cli", repo: "cli", number: 0 } }),
  ).rejects.toBeInstanceOf(RPCValidationError);
});
