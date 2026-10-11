import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext, fixture } from "../../../test/fake-gh.ts";
import { inbox } from "./inbox.ts";
import { setPinned } from "./set-pinned.ts";

test("asks GitHub for the stored pins and answers a valid inbox", async () => {
  const { ctx, calls } = fakeContext({ graphql: { Inbox: fixture("inbox.json") } });
  for (const ref of [
    { owner: "cli", repo: "cli", number: 9000 },
    { owner: "nope-nope-xyz", repo: "none", number: 1 },
    { owner: "cli", repo: "cli", number: 9001 },
  ]) {
    await setPinned.execute(ctx, { account: "octocat", ref, pinned: true });
  }

  const result = (await callProcedure(inbox, ctx, null)) as { pinned: { url: string }[] };

  expect(calls[0]).toMatchObject({
    variables: {
      u0: "https://github.com/cli/cli/pull/9000",
      u1: "https://github.com/nope-nope-xyz/none/pull/1",
      u2: "https://github.com/cli/cli/pull/9001",
    },
  });
  expect(result.pinned.map((pr) => pr.url)).toEqual(["https://github.com/cli/cli/pull/9000"]);
});
