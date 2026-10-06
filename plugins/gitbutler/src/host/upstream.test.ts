import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Branch, Workspace } from "../shared/schema.ts";
import { runGit } from "./cli.ts";
import { compareWithRemotes, incoming } from "./upstream.ts";

const signal = new AbortController().signal;
let repository = "";

const git = (...args: string[]) => runGit(repository, args, signal);

async function commitFile(name: string, text: string): Promise<string> {
  await writeFile(join(repository, name), text);
  await git("add", "--all");
  await git("commit", "--quiet", "-m", `change ${name}`);
  return (await git("rev-parse", "HEAD")).trim();
}

/** A branch as `but status` reports it: needing force, with `upstream` remote commits. */
function branch(name: string, upstream: number): Branch {
  const commit = {
    commitId: "0".repeat(40),
    changeId: null,
    message: "",
    authorName: "",
    createdAt: "",
    conflicted: false,
  };
  return {
    name,
    status: "diverged",
    rawStatus: "unpushedCommitsRequiringForce",
    push: "force",
    reviewId: null,
    ci: null,
    commits: [commit],
    upstreamCommits: Array.from({ length: upstream }, () => commit),
    newUpstream: upstream,
  };
}

function workspaceOf(...branches: Branch[]): Workspace {
  return {
    state: "ready",
    reason: null,
    repoName: "repo",
    unassignedChanges: [],
    stacks: branches.map((entry) => ({
      key: entry.name,
      branches: [entry],
      assignedChanges: [],
    })),
    base: null,
    upstream: null,
    conflictedFiles: [],
  };
}

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), "gitbutler-upstream-"));
  await git("init", "--quiet", "--initial-branch=main", ".");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test Person");
  await git("config", "commit.gpgsign", "false");
  // `fork` lists before `origin`, so comparing with origin follows the setting, not luck.
  await git("remote", "add", "fork", "https://example.com/fork.git");
  await git("remote", "add", "origin", "https://example.com/origin.git");
  await git("config", "gitbutler.project.pushremote", "origin");
  const base = await commitFile("base.txt", "base\n");

  // Behind: the remote went on from the local head, which has nothing new.
  const behindRemote = await commitFile("behind.txt", "from another machine\n");
  await git("branch", "scott/behind", base);
  await git("update-ref", "refs/remotes/origin/scott/behind", behindRemote);
  // A remote that lacks the branch's head entirely must not be the one compared.
  await git("update-ref", "refs/remotes/fork/scott/behind", base);

  // Diverged: each side has a commit the other lacks.
  await git("checkout", "--quiet", "-b", "scott/diverged", base);
  await commitFile("local.txt", "local\n");
  await git("checkout", "--quiet", "--detach", base);
  await git(
    "update-ref",
    "refs/remotes/origin/scott/diverged",
    await commitFile("remote.txt", "x\n"),
  );

  // Rebased: the remote holds the old copy of the branch's one commit.
  await git("checkout", "--quiet", "--detach", base);
  const old = await commitFile("feature.txt", "feature\n");
  await git("update-ref", "refs/remotes/origin/scott/rebased", old);
  await git("checkout", "--quiet", "--detach", base);
  await commitFile("main.txt", "main moved on\n");
  await writeFile(join(repository, "feature.txt"), "feature\n");
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "change feature.txt");
  await git("branch", "scott/rebased", "HEAD");

  // Tracks fork, where new work landed. origin holds only an old copy.
  await git("branch", "scott/forked", "scott/rebased");
  await git("config", "branch.scott/forked.remote", "fork");
  await git("config", "branch.scott/forked.merge", "refs/heads/scott/forked");
  await git("update-ref", "refs/remotes/origin/scott/forked", old);
  await git("checkout", "--quiet", "scott/rebased");
  await git(
    "update-ref",
    "refs/remotes/fork/scott/forked",
    await commitFile("forked.txt", "landed on the fork\n"),
  );

  // Behind on two commits whose paths git would C-quote without -z.
  await git("checkout", "--quiet", "--detach", base);
  await commitFile('naïve "q".txt', "odd\n");
  await git("update-ref", "refs/remotes/origin/scott/odd", await commitFile("sp ace.txt", "odd\n"));
  await git("branch", "scott/odd", base);

  // Behind on a merge whose resolution adds a file neither side had.
  await git("checkout", "--quiet", "--detach", base);
  const side = await commitFile("side.txt", "side\n");
  await git("checkout", "--quiet", "--detach", base);
  await commitFile("first.txt", "first\n");
  await git("merge", "--quiet", "--no-ff", "--no-commit", side);
  await writeFile(join(repository, "resolution.txt"), "resolved\n");
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "merge");
  await git("update-ref", "refs/remotes/origin/scott/merged", "HEAD");
  await git("branch", "scott/merged", base);
  await git("checkout", "--quiet", "main");
});

afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

test("a branch only behind its remote reads as behind, with nothing to push", async () => {
  const [stack] = (
    await compareWithRemotes(repository, workspaceOf(branch("scott/behind", 1)), signal)
  ).stacks;
  expect(stack!.branches[0]).toMatchObject({ status: "behind", push: "none", newUpstream: 1 });
});

test("a diverged branch keeps its force push, with the remote's commit counted as new", async () => {
  const [stack] = (
    await compareWithRemotes(repository, workspaceOf(branch("scott/diverged", 1)), signal)
  ).stacks;
  expect(stack!.branches[0]).toMatchObject({ status: "diverged", push: "force", newUpstream: 1 });
});

test("old copies of a rebased branch's commits are upstream, but nothing new", async () => {
  const [stack] = (
    await compareWithRemotes(repository, workspaceOf(branch("scott/rebased", 1)), signal)
  ).stacks;
  expect(stack!.branches[0]).toMatchObject({ status: "diverged", push: "force", newUpstream: 0 });
});

test("a branch with no remote-tracking ref keeps what GitButler said", async () => {
  const lonely = branch("scott/nowhere", 2);
  const [stack] = (await compareWithRemotes(repository, workspaceOf(lonely), signal)).stacks;
  expect(stack!.branches[0]).toEqual(lonely);
});

test("a branch git tracks on another remote is compared with that remote", async () => {
  const [stack] = (
    await compareWithRemotes(repository, workspaceOf(branch("scott/forked", 1)), signal)
  ).stacks;
  expect(stack!.branches[0]).toMatchObject({ status: "behind", push: "none", newUpstream: 1 });
});

test("incoming names the remote's new commits and their files, not old copies", async () => {
  expect(
    await incoming(repository, "scott/behind", "refs/remotes/origin/scott/behind", signal),
  ).toEqual({ commits: 1, files: ["behind.txt"] });
  expect(
    await incoming(repository, "scott/rebased", "refs/remotes/origin/scott/rebased", signal),
  ).toEqual({ commits: 0, files: [] });
});

test("incoming reads paths git would quote, as they are", async () => {
  const { commits, files } = await incoming(
    repository,
    "scott/odd",
    "refs/remotes/origin/scott/odd",
    signal,
  );
  expect({ commits, files: files.toSorted() }).toEqual({
    commits: 2,
    files: ['naïve "q".txt', "sp ace.txt"],
  });
});

test("incoming counts the files a merge's resolution changed", async () => {
  const { files } = await incoming(
    repository,
    "scott/merged",
    "refs/remotes/origin/scott/merged",
    signal,
  );
  expect(files.toSorted()).toEqual(["first.txt", "resolution.txt", "side.txt"]);
});
