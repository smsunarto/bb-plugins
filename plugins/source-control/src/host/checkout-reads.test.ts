/**
 * The plain-git checkout reads other plugins use: a clone of a bare origin
 * on a feature branch with commits, uncommitted edits, and an untracked file.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { isolate } from "../../test/isolate.ts";
import { git } from "../../test/repos.ts";
import { readCheckoutFiles, readCheckoutPatches, readCheckoutStatus } from "./checkout-reads.ts";

const env = await isolate("source-control-checkout-reads");
const signal = new AbortController().signal;
let scratch = "",
  clone = "",
  first = "",
  second = "";

async function commit(file: string, content: string, message: string) {
  await writeFile(join(clone, file), content);
  git(clone, "add", "--", file);
  git(clone, "commit", "--quiet", "-m", message);
  return git(clone, "rev-parse", "HEAD").trim();
}

beforeEach(async () => {
  scratch = join(env.root, `case-${Math.random().toString(36).slice(2)}`);
  clone = join(scratch, "clone");
  const origin = join(scratch, "origin.git");
  await mkdir(clone, { recursive: true });
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(clone, "init", "--quiet", "--initial-branch=main", ".");
  await commit("base.txt", "one\ntwo\n", "chore: base");
  git(clone, "remote", "add", "origin", origin);
  git(clone, "push", "--quiet", "-u", "origin", "main");
  git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(clone, "switch", "--quiet", "-c", "feature");
  first = await commit("first.txt", "a\nb\nc\n", "feat: first");
  second = await commit("base.txt", "one\nTWO\n", "feat: second");
  // Uncommitted: an edit to a committed file, and an untracked one.
  await writeFile(join(clone, "first.txt"), "a\nb\nc\nd\n");
  await writeFile(join(clone, "notes.md"), "x\ny");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

afterAll(async () => {
  await env.cleanup();
});

test("status names the branch, the remote's default branch, uncommitted lines, and the branch's commits", async () => {
  const status = await readCheckoutStatus(clone, null, signal);
  expect(status).toMatchObject({
    state: "read",
    head: { kind: "branch", name: "feature", sha: second },
    defaultBranch: "main",
    base: "main",
    // first.txt +1, notes.md +2 (its last line has no newline).
    uncommitted: { files: 2, additions: 3, deletions: 0 },
    mergeBase: { ahead: 2, behind: 0 },
  });
  if (status.state !== "read") throw new Error("unread");
  expect(status.mergeBase?.commits.map((entry) => [entry.sha, entry.subject])).toEqual([
    [second, "feat: second"],
    [first, "feat: first"],
  ]);
  expect(status.mergeBase?.commits[0]?.authoredAt).toBeGreaterThan(0);
});

test("status reads a directory outside git as not-git, and a deleted one as missing", async () => {
  const plain = join(scratch, "plain");
  await mkdir(plain);
  expect(await readCheckoutStatus(plain, null, signal)).toEqual({ state: "not-git" });
  expect(await readCheckoutStatus(join(scratch, "gone"), null, signal)).toEqual({
    state: "missing",
  });
});

test("uncommitted files list edits and untracked files with line counts and inline patches", async () => {
  const read = await readCheckoutFiles(clone, { kind: "uncommitted" }, signal);
  expect(read.truncated).toBe(false);
  expect(read.files).toEqual([
    {
      path: "first.txt",
      previousPath: null,
      kind: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      untracked: false,
    },
    {
      path: "notes.md",
      previousPath: null,
      kind: "added",
      additions: 2,
      deletions: 0,
      binary: false,
      untracked: true,
    },
  ]);
  expect(read.patches.map((patch) => patch.path)).toEqual(["first.txt", "notes.md"]);
  expect(read.patches[0]?.patch).toContain("+d");
});

test("the branch target covers its commits and its uncommitted work since it left the base", async () => {
  const read = await readCheckoutFiles(clone, { kind: "branch", base: "main" }, signal);
  expect(read.files.map((file) => [file.path, file.kind, file.additions, file.deletions])).toEqual([
    ["base.txt", "modified", 1, 1],
    ["first.txt", "added", 4, 0],
    ["notes.md", "added", 2, 0],
  ]);
});

test("a commit target lists that commit's own files, and its patches by path", async () => {
  const read = await readCheckoutFiles(clone, { kind: "commit", sha: second.slice(0, 7) }, signal);
  expect(read.files.map((file) => file.path)).toEqual(["base.txt"]);
  const patches = await readCheckoutPatches(
    clone,
    { kind: "commit", sha: second },
    [{ path: "base.txt", previousPath: null }],
    signal,
  );
  expect(patches).toHaveLength(1);
  expect(patches[0]?.patch).toContain("+TWO");
});

test("patches of an untracked and a renamed file", async () => {
  git(clone, "mv", "base.txt", "moved.txt");
  const listed = await readCheckoutFiles(clone, { kind: "uncommitted" }, signal);
  const moved = listed.files.find((file) => file.path === "moved.txt");
  expect(moved).toMatchObject({ kind: "renamed", previousPath: "base.txt" });
  const patches = await readCheckoutPatches(
    clone,
    { kind: "uncommitted" },
    [
      { path: "moved.txt", previousPath: "base.txt" },
      { path: "notes.md", previousPath: null },
    ],
    signal,
  );
  expect(patches.map((patch) => [patch.path, patch.kind])).toEqual([
    ["moved.txt", "renamed"],
    ["notes.md", "added"],
  ]);
});

test("a base branch the checkout lacks fails with its name", async () => {
  await expect(readCheckoutFiles(clone, { kind: "branch", base: "nope" }, signal)).rejects.toThrow(
    "no branch nope",
  );
});
