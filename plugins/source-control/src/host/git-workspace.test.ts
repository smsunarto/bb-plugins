/**
 * The plain-git provider on a linked worktree of a repository with a bare
 * origin. Ported from `plugins/gitbutler/src/host/git-workspace.test.ts`
 * (reads, patches, push, the target pull, and land).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import type { VcsAction } from "../core/change.ts";
import { fakeBut } from "../../test/fake-but.ts";
import { isolate } from "../../test/isolate.ts";
import { git } from "../../test/repos.ts";
import { readCheckout, type Checkout } from "./checkout.ts";
import { runGitWrite } from "./git-actions.ts";
import { parseGitStatus, readGitPatches, readGitWorkspace } from "./git-workspace.ts";

const env = await isolate("source-control-git");
const signal = new AbortController().signal;
const name = "scott/isolated";
let scratch = "",
  main = "",
  isolated = "",
  remote = "",
  base = "",
  tip = "";
let restore: (() => Promise<void>) | undefined;

async function commit(path: string, file: string, content: string, message: string) {
  await writeFile(join(path, file), content);
  git(path, "add", "--", file);
  git(path, "commit", "--quiet", "-m", message);
  return git(path, "rev-parse", "HEAD").trim();
}
async function checkout(path = isolated): Promise<Checkout> {
  const found = await readCheckout(path, signal);
  if (!found) throw new Error(`${path} is not a checkout`);
  return found;
}
async function workspace(path = isolated) {
  return readGitWorkspace(await checkout(path), signal);
}
async function branch(path = isolated) {
  return (await workspace(path)).stacks[0]!.branches[0]!;
}
const ref = (path: string, revision: string) => git(path, "rev-parse", revision).trim();
const act = (action: VcsAction) => runGitWrite(isolated, action, signal);
const push = (force = false, acceptedLoss: string[] = []) =>
  act({ kind: "push", branch: name, force, acceptedLoss });
const land = (message: string | null) =>
  act({ kind: "land", branch: name, message, accepted: null });

beforeEach(async () => {
  scratch = join(env.root, `case-${Math.random().toString(36).slice(2)}`);
  main = join(scratch, "main");
  isolated = join(scratch, "external", "isolated");
  remote = join(scratch, "origin.git");
  await mkdir(main, { recursive: true });
  git(main, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(main, "init", "--quiet", "--initial-branch=main", ".");
  base = await commit(main, "base.txt", "base\n", "chore: base");
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "--quiet", "-u", "origin", "main");
  git(main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(main, "worktree", "add", "--quiet", "-b", name, isolated);
  await commit(isolated, "first.txt", "first\n", "feat: first\n\nFirst body.");
  tip = await commit(isolated, "second.txt", "second\n", "feat: second");
});

afterEach(async () => {
  await restore?.();
  restore = undefined;
  await rm(scratch, { recursive: true, force: true });
});

afterAll(async () => {
  await env.cleanup();
});

test("a plain checkout reads as one stack of its branch, with its own commits, edits, and target", async () => {
  const log = join(scratch, "but.log");
  restore = await fakeBut(
    `printf '%s\\n' "$*" >> '${log}'; echo '{"error":"must_not_run"}'; exit 1`,
  );
  await writeFile(join(isolated, "base.txt"), "local edit\n");
  await writeFile(join(isolated, "new file\nname.txt"), "new\n");
  await writeFile(join(main, "main-only.txt"), "keep main dirty\n");
  const value = await workspace();
  expect(value).toMatchObject({
    provider: "git",
    path: isolated,
    commonDir: join(main, ".git"),
    checkedOut: name,
    github: null,
    uncommitted: [
      { path: "base.txt", kind: "modified" },
      { path: "new file\nname.txt", kind: "added" },
    ],
    moreUncommitted: 0,
    conflicted: [],
    target: {
      ref: "origin/main",
      head: base,
      behind: 0,
      base: { id: base, subject: "chore: base" },
    },
  });
  expect(value.stacks).toHaveLength(1);
  expect(value.stacks[0]).toMatchObject({ key: name, assigned: [] });
  expect(value.stacks[0]!.branches[0]).toMatchObject({
    name,
    head: tip,
    remote: null,
    status: "unpushed",
    push: "push",
    ahead: 0,
    behind: 0,
    moreCommits: 0,
  });
  expect(value.stacks[0]!.branches[0]!.commits.map(({ subject }) => subject)).toEqual([
    "feat: second",
    "feat: first",
  ]);
  expect(await readFile(join(main, "main-only.txt"), "utf8")).toBe("keep main dirty\n");
  expect(await readFile(log, "utf8").catch(() => "")).toBe("");
});

test("plain patches include staged, unstaged, untracked and selected-commit changes", async () => {
  await writeFile(join(isolated, "first.txt"), "staged\n");
  git(isolated, "add", "first.txt");
  await writeFile(join(isolated, "first.txt"), "staged plus working\n");
  await writeFile(join(isolated, "new.txt"), "untracked contents\n");
  const patches = await readGitPatches(await checkout(), { kind: "uncommitted" }, signal);
  expect(patches.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
    { path: "first.txt", kind: "modified" },
    { path: "new.txt", kind: "added" },
  ]);
  expect(patches.files[0]?.patch).toContain("+staged plus working");
  expect(patches.files[1]?.patch).toContain("+untracked contents");
  const shown = await readGitPatches(await checkout(), { kind: "commit", commitId: tip }, signal);
  expect(shown.files.map(({ path }) => path)).toEqual(["second.txt"]);
});

test("an unborn branch and its staged and untracked patches remain readable", async () => {
  const unborn = join(scratch, "unborn");
  await mkdir(unborn);
  git(unborn, "init", "--quiet", "--initial-branch=fresh", ".");
  await writeFile(join(unborn, "staged.txt"), "staged\n");
  git(unborn, "add", "staged.txt");
  await writeFile(join(unborn, "untracked.txt"), "untracked\n");
  expect(await branch(unborn)).toMatchObject({
    name: "fresh",
    head: null,
    status: "empty",
    commits: [],
    push: "none",
  });
  const patches = await readGitPatches(await checkout(unborn), { kind: "uncommitted" }, signal);
  expect(patches.files.map(({ path }) => path)).toEqual(["staged.txt", "untracked.txt"]);
});

test("push publishes only the checked-out branch and sets its first upstream", async () => {
  expect(await push()).toEqual({ status: "done" });
  expect(ref(remote, `refs/heads/${name}`)).toBe(tip);
  expect(ref(remote, "main")).toBe(base);
  expect(await branch()).toMatchObject({
    status: "pushed",
    remote: { ref: `origin/${name}`, name },
    ahead: 0,
    behind: 0,
  });
  expect(ref(main, "HEAD")).toBe(base);
});

test("a differently named upstream is the remote and the push destination; a triangular push is refused", async () => {
  git(isolated, "push", "--quiet", "-u", "origin", `${name}:review-feature`);
  const next = await commit(isolated, "third.txt", "third\n", "feat: third");
  // A pull request's head is the name on the remote, not the local one.
  expect(await branch()).toMatchObject({
    remote: { ref: "origin/review-feature", name: "review-feature" },
    status: "ahead",
    ahead: 1,
  });
  expect(await push()).toEqual({ status: "done" });
  expect(ref(remote, "review-feature")).toBe(next);
  expect(git(remote, "for-each-ref", "--format=%(refname)", `refs/heads/${name}`).trim()).toBe("");

  const fork = join(scratch, "fork.git");
  git(main, "init", "--bare", "--quiet", fork);
  git(main, "remote", "add", "fork", fork);
  git(main, "config", `branch.${name}.pushRemote`, "fork");
  expect(await branch()).toMatchObject({ status: "unknown", push: "none" });
  await expect(push()).rejects.toThrow("push remote differs");
  expect(git(fork, "for-each-ref", "--format=%(refname)").trim()).toBe("");
});

test("a force push asks about the upstream commits it would delete, then publishes the read tip", async () => {
  await push();
  const elsewhere = join(scratch, "force-contributor");
  git(main, "worktree", "add", "--quiet", "-b", "contributor", elsewhere, tip);
  const upstream = await commit(elsewhere, "remote.txt", "remote\n", "feat: remote");
  git(elsewhere, "push", "--quiet", "origin", `HEAD:${name}`);
  const local = await commit(isolated, "local.txt", "local\n", "feat: local");
  await expect(push(false)).rejects.toThrow("The remote branch diverged");
  expect(await push(true)).toEqual({ status: "confirm", risk: null, loss: [upstream] });
  expect(ref(remote, name)).toBe(upstream);
  expect(await push(true, [upstream])).toEqual({ status: "done" });
  expect(ref(remote, name)).toBe(local);
});

test("pull asks before rebasing a diverged branch onto the target, then rebases only this checkout", async () => {
  const target = await commit(main, "incoming.txt", "incoming\n", "feat: incoming");
  git(main, "push", "--quiet", "origin", "main");
  await writeFile(join(main, "sentinel.txt"), "untouched main work\n");
  expect(await act({ kind: "pull", accepted: null })).toEqual({
    status: "confirm",
    risk: { conflicted: [name], overlapsUncommitted: false },
    loss: null,
  });
  expect(
    await act({ kind: "pull", accepted: { conflicted: [name], overlapsUncommitted: false } }),
  ).toEqual({ status: "done" });
  const value = await workspace();
  expect(value.target?.base?.id).toBe(target);
  expect(value.stacks[0]!.branches[0]!.commits.map(({ subject }) => subject)).toEqual([
    "feat: second",
    "feat: first",
  ]);
  expect(await readFile(join(main, "sentinel.txt"), "utf8")).toBe("untouched main work\n");
  expect(ref(main, "HEAD")).toBe(target);
  expect(await act({ kind: "pull", accepted: null })).toEqual({ status: "upToDate" });
});

test("writes that rewrite the checkout refuse uncommitted changes without changing refs or files", async () => {
  await writeFile(join(isolated, "first.txt"), "preserve dirty work\n");
  await expect(land("feat: combined")).rejects.toThrow("uncommitted changes");
  await expect(act({ kind: "pull", accepted: null })).rejects.toThrow("uncommitted changes");
  expect(await checkout()).toMatchObject({ branch: name, head: tip });
  expect(await readFile(join(isolated, "first.txt"), "utf8")).toBe("preserve dirty work\n");
  expect(ref(remote, "main")).toBe(base);
});

test("squash-land publishes one commit parented to the target, without moving main", async () => {
  await writeFile(join(main, "sentinel.txt"), "keep main\n");
  expect(await land("feat: isolated work\n\nSquashed body.")).toEqual({ status: "done" });
  const landed = ref(remote, "main");
  expect(git(remote, "show", "-s", "--format=%B", landed).trim()).toBe(
    "feat: isolated work\n\nSquashed body.",
  );
  expect(ref(remote, `${landed}^`)).toBe(base);
  expect(git(remote, "rev-list", "--count", `${base}..main`).trim()).toBe("1");
  // The landed branch is gone and the checkout sits on what landed.
  expect(await checkout()).toMatchObject({ branch: null, head: landed });
  expect(ref(main, "HEAD")).toBe(base);
  expect(await readFile(join(main, "sentinel.txt"), "utf8")).toBe("keep main\n");
});

test("a single-commit land onto a moved target keeps the original author and message", async () => {
  git(isolated, "reset", "--quiet", "--hard", base);
  await writeFile(join(isolated, "contributed.txt"), "original contribution\n");
  git(isolated, "add", "contributed.txt");
  git(
    isolated,
    "commit",
    "--quiet",
    "--author=Original Contributor <contributor@example.com>",
    "--date=2001-02-03T04:05:06+05:30",
    "-m",
    "feat: contributed work\n\nOriginal body.",
  );
  const target = await commit(main, "incoming.txt", "incoming\n", "feat: incoming");
  git(main, "push", "--quiet", "origin", "main");
  await expect(land("explicit changed message")).rejects.toThrow("confirm its commit message");
  expect(ref(remote, "main")).toBe(target);
  expect(await land(null)).toEqual({ status: "done" });
  const landed = ref(remote, "main");
  expect(ref(remote, `${landed}^`)).toBe(target);
  expect(git(remote, "show", "-s", "--format=%an%x00%ae%x00%aI", landed).trim()).toBe(
    ["Original Contributor", "contributor@example.com", "2001-02-03T04:05:06+05:30"].join("\0"),
  );
  expect(git(remote, "show", "-s", "--format=%B", landed).trimEnd()).toBe(
    "feat: contributed work\n\nOriginal body.",
  );
});

test("land refuses a conflicting target without publishing or changing the checkout", async () => {
  tip = await commit(isolated, "base.txt", "isolated change\n", "feat: isolated base");
  const target = await commit(main, "base.txt", "main change\n", "feat: main base");
  git(main, "push", "--quiet", "origin", "main");
  await expect(land("feat: combined")).rejects.toThrow("conflicts with its target");
  expect(ref(remote, "main")).toBe(target);
  expect(ref(isolated, "HEAD")).toBe(tip);
  expect(await readFile(join(isolated, "base.txt"), "utf8")).toBe("isolated change\n");
});

test("a rejected landing publication keeps the branch and the target unchanged", async () => {
  await writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(land("feat: combined")).rejects.toThrow("did not leave refs/heads/main");
  expect(ref(remote, "main")).toBe(base);
  expect(await checkout()).toMatchObject({ branch: name, head: tip });
});

test("a branch the target already has as one squash is up to date, and lands nothing", async () => {
  git(main, "merge", "--quiet", "--squash", name);
  git(main, "commit", "--quiet", "-m", "feat: already landed");
  git(main, "push", "--quiet", "origin", "main");
  const landed = ref(remote, "main");
  expect(await land("feat: combined")).toEqual({ status: "upToDate" });
  expect(ref(remote, "main")).toBe(landed);
  expect(await checkout()).toMatchObject({ branch: name, head: tip });
});

test("a branch GitButler's metadata records is not changed from a plain checkout", async () => {
  const storage = join(main, ".git", "gitbutler");
  await mkdir(storage, { recursive: true });
  const metadata = (head: string) =>
    `[branches.abc]\nid = "abc"\nname = ""\n\n[[branches.abc.heads]]\nname = "${head}"\narchived = false\n`;
  await writeFile(join(storage, "virtual_branches.toml"), metadata(name));
  await expect(push()).rejects.toThrow("recorded in GitButler metadata");
  expect(git(remote, "for-each-ref", "--format=%(refname)", `refs/heads/${name}`).trim()).toBe("");
  // Another branch's record does not hold this one back.
  await writeFile(join(storage, "virtual_branches.toml"), metadata("scott/other"));
  expect(await push()).toEqual({ status: "done" });
  // A quoted name on a line of its own is not a record: only the parsed table counts.
  await writeFile(
    join(storage, "virtual_branches.toml"),
    `${metadata("scott/other")}notes = """\nname = "${name}"\n"""\n`,
  );
  expect(await push()).toEqual({ status: "upToDate" });
  // Metadata that does not parse refuses the write rather than guessing.
  await writeFile(join(storage, "virtual_branches.toml"), `[branches.abc\nname = "${name}"\n`);
  await expect(push()).rejects.toThrow("GitButler branch metadata is invalid");
});

test("a write naming another branch than the one checked out is refused", async () => {
  await expect(
    act({ kind: "push", branch: "scott/other", force: false, acceptedLoss: [] }),
  ).rejects.toThrow("scott/other is no longer checked out here.");
});

test("status parsing keeps rename destinations and unmerged paths", () => {
  expect(parseGitStatus("R  new name\0old name\0UU conflict.txt\0?? new\nfile\0")).toEqual({
    changes: [
      { path: "new name", kind: "renamed" },
      { path: "conflict.txt", kind: "modified" },
      { path: "new\nfile", kind: "added" },
    ],
    conflicts: ["conflict.txt"],
    untracked: ["new\nfile"],
  });
});
