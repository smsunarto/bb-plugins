import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchOptions,
} from "@get-bb/plugin-sdk/host";
import type { WhiteboardHostSignals } from "../../shared/contracts/host-contract.ts";
import { gitCommonDir } from "../../shared/node/vendor/local-vcs/src/index.ts";
import {
  createInProcessHostClient,
  IN_PROCESS_HOST_ID,
} from "../../server/lib/host-io/testing/in-process.ts";
import { ignoredGitPaths, watchWorktree, unwatchWorktree } from "./watch.ts";

const BOOKKEEPING = ["objects", "logs", "gitbutler", "dev-fast"];
const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

function scratch() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "whiteboard-watch-")));
  temps.push(root);
  return root;
}

it("ignores a primary checkout's .git and only the bookkeeping inside it, and debounces", async () => {
  const checkout = scratch();
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  const common = (await gitCommonDir(checkout))!;
  expect(common).toBe(path.join(checkout, ".git"));
  const seen: ExperimentalHostWatchOptions[] = [];
  const context = {
    experimental_watch(options: ExperimentalHostWatchOptions) {
      seen.push(options);
      return Promise.resolve({ dispose: async () => {} });
    },
  } as unknown as ExperimentalHostRpcContext<WhiteboardHostSignals>;
  for (const rootPath of [checkout, common]) {
    await watchWorktree({ watchId: rootPath, rootPath, gitCommonDir: common }, context);
    await unwatchWorktree({ watchId: rootPath });
  }
  // The common directory's own watch reports HEAD, refs and the index once.
  expect(seen[0]).toEqual({ rootPath: checkout, ignoredPaths: [".git"], debounceMs: 250 });
  expect(seen[1]?.ignoredPaths).toEqual(BOOKKEEPING);
});

it("ignores nothing without a common directory or in a linked worktree, and resolves symlinks", async () => {
  const checkout = scratch();
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  const common = (await gitCommonDir(checkout))!;
  const link = path.join(scratch(), "link");
  symlinkSync(checkout, link);
  expect(await ignoredGitPaths(link, common)).toEqual([".git"]);
  expect(await ignoredGitPaths(path.join(link, ".git"), common)).toEqual(BOOKKEEPING);
  // A linked worktree's `.git` is a file; its common directory lies elsewhere.
  const linked = scratch();
  mkdirSync(path.join(linked, "objects"));
  writeFileSync(path.join(linked, "HEAD"), "ref: refs/heads/main\n");
  expect(await ignoredGitPaths(linked, common)).toEqual([]);
  expect(await ignoredGitPaths(checkout, undefined)).toEqual([]);
});

it("reports source files named HEAD and objects/ beside a common directory not named .git", async () => {
  const parent = scratch();
  const checkout = path.join(parent, "checkout");
  const store = path.join(parent, "store");
  execFileSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", store, checkout]);
  mkdirSync(path.join(checkout, "objects"));
  writeFileSync(path.join(checkout, "HEAD"), "source\n");
  writeFileSync(path.join(checkout, "objects", "example.ts"), "export {};\n");
  const common = (await gitCommonDir(checkout))!;
  expect(common).toBe(store);
  expect(await ignoredGitPaths(checkout, common)).toEqual([]);
  expect(await ignoredGitPaths(store, common)).toEqual(BOOKKEEPING);

  // The real host entry, its contract and a watcher that honors ignores like the daemon.
  const client = createInProcessHostClient();
  const changed: string[] = [];
  const off = client.experimental_onSignal("worktreeChanged", ({ payload }) => {
    changed.push((payload as { watchId: string }).watchId);
  });
  const call = (method: "watchWorktree" | "unwatchWorktree", input: object) =>
    client.call(method, input as never, { hostId: IN_PROCESS_HOST_ID });
  try {
    for (const [watchId, rootPath] of [
      ["checkout", checkout],
      ["store", store],
    ])
      await call("watchWorktree", { watchId, rootPath, gitCommonDir: common });
    let edit = 0;
    await vi.waitFor(
      () => {
        writeFileSync(
          path.join(checkout, "objects", "example.ts"),
          `export const v = ${edit++};\n`,
        );
        writeFileSync(path.join(store, "refs", "heads", "probe"), `${edit}\n`);
        expect(changed).toContain("checkout");
        expect(changed).toContain("store");
        // Writes slower than the 250 ms quiet period, so each one is delivered.
      },
      { timeout: 5_000, interval: 400 },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    changed.length = 0;
    mkdirSync(path.join(store, "objects", "ab"), { recursive: true });
    writeFileSync(path.join(store, "objects", "ab", "cdef"), "blob\n");
    mkdirSync(path.join(store, "logs"), { recursive: true });
    writeFileSync(path.join(store, "logs", "HEAD"), "reflog\n");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(changed).toEqual([]);
  } finally {
    off();
    for (const watchId of ["checkout", "store"]) await call("unwatchWorktree", { watchId });
  }
});
