import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { setPinned } from "./set-pinned.ts";

const a = { owner: "cli", repo: "cli", number: 1 };
const b = { owner: "acme", repo: "api", number: 2 };

test("pins and unpins as an account, answering the pins in order", async () => {
  const { ctx } = fakeContext();
  await setPinned.execute(ctx, { account: "work", ref: a, pinned: true });
  expect(await setPinned.execute(ctx, { account: "home", ref: b, pinned: true })).toEqual({
    pinned: [
      { ...a, account: "work" },
      { ...b, account: "home" },
    ],
  });
  // A pull request is pinned once: unpinning works from either account.
  expect(await setPinned.execute(ctx, { account: "home", ref: a, pinned: false })).toEqual({
    pinned: [{ ...b, account: "home" }],
  });
});

test("two pins sent at once both land", async () => {
  const { ctx } = fakeContext();

  await Promise.all([
    setPinned.execute(ctx, { account: "octocat", ref: a, pinned: true }),
    setPinned.execute(ctx, { account: "octocat", ref: b, pinned: true }),
  ]);

  expect(await ctx.store.pins()).toEqual([
    { ...a, account: "octocat" },
    { ...b, account: "octocat" },
  ]);
});
