import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareCheckout } from "../host";

it("fetches a retained PR ref and verifies its SHA before adding the worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slopcop-checkout-"));
  const calls: string[][] = [];
  const input = {
    source: root,
    path: path.join(root, "worktree"),
    ref: "refs/slopcop/thr_test",
    number: 1125,
    head: "3".repeat(40),
  };
  try {
    const result = await prepareCheckout(input, new AbortController().signal, async (_, args) => {
      calls.push(args);
      return args[0] === "rev-parse" ? input.head : "";
    });
    expect(result.path).toBe(input.path);
    expect(calls).toEqual([
      ["fetch", "--no-tags", "origin", "+refs/pull/1125/head:refs/slopcop/thr_test"],
      ["rev-parse", "refs/slopcop/thr_test"],
      ["worktree", "add", "--detach", input.path, input.head],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("refuses a changed PR head without creating a worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slopcop-checkout-"));
  const calls: string[][] = [];
  try {
    await expect(
      prepareCheckout(
        {
          source: root,
          path: path.join(root, "worktree"),
          ref: "refs/slopcop/thr_test",
          number: 1125,
          head: "3".repeat(40),
        },
        new AbortController().signal,
        async (_, args) => {
          calls.push(args);
          return "4".repeat(40);
        },
      ),
    ).rejects.toThrow("PR head changed");
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
