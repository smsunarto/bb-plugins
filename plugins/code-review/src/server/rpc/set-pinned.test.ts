import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { setPinned } from "./set-pinned.ts";

test("pins and unpins, answering the pins in order", async () => {
  const { ctx } = fakeContext();
  const a = { owner: "cli", repo: "cli", number: 1 };
  const b = { owner: "acme", repo: "api", number: 2 };
  await setPinned.execute(ctx, { ref: a, pinned: true });
  expect(await setPinned.execute(ctx, { ref: b, pinned: true })).toEqual({ pinned: [a, b] });
  expect(await setPinned.execute(ctx, { ref: a, pinned: false })).toEqual({ pinned: [b] });
});

test("two pins sent at once both land", async () => {
  const { ctx } = fakeContext();
  const a = { owner: "cli", repo: "cli", number: 1 };
  const b = { owner: "acme", repo: "api", number: 2 };

  await Promise.all([
    setPinned.execute(ctx, { ref: a, pinned: true }),
    setPinned.execute(ctx, { ref: b, pinned: true }),
  ]);

  expect(await ctx.store.pins()).toEqual([a, b]);
});
