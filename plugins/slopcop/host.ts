import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { promisify } from "node:util";
import { reviewCheckoutContract } from "./lib/review-checkout-contract";

const exec = promisify(execFile);
async function git(source: string, args: string[], signal: AbortSignal) {
  const result = await exec("git", ["-C", source, ...args], {
    signal,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

export async function prepareCheckout(
  input: z.infer<typeof reviewCheckoutContract.prepare.input>,
  signal: AbortSignal,
  runGit: typeof git = git,
) {
  if (
    await stat(input.path).then(
      () => true,
      () => false,
    )
  ) {
    const head = await runGit(input.path, ["rev-parse", "HEAD"], signal);
    if (head !== input.head) throw new Error("Existing review worktree has a different HEAD");
    return { path: input.path };
  }
  await runGit(
    input.source,
    ["fetch", "--no-tags", "origin", `+refs/pull/${input.number}/head:${input.ref}`],
    signal,
  );
  const head = await runGit(input.source, ["rev-parse", input.ref], signal);
  if (head !== input.head)
    throw new Error("PR head changed before checkout; dispatch a fresh review");
  await mkdir(path.dirname(input.path), { recursive: true });
  await runGit(input.source, ["worktree", "add", "--detach", input.path, input.head], signal);
  return { path: input.path };
}

export default experimental_defineHostEntry({
  contract: reviewCheckoutContract,
  handlers: {
    prepare(input, { signal }) {
      return prepareCheckout(input, signal);
    },
    async remove(input, { signal }) {
      if (
        await stat(input.path).then(
          () => true,
          () => false,
        )
      ) {
        // Refuse to discard a dirty worktree; preserve unexpected edits for inspection.
        await git(input.source, ["worktree", "remove", input.path], signal);
      }
      await git(input.source, ["update-ref", "-d", input.ref], signal);
      return {};
    },
  },
});
