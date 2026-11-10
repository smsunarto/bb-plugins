/** Ported from `plugins/gitbutler/src/host/upstream.test.ts`, without the per-branch pull's `incoming`. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isolate } from "../../test/isolate.ts";
import { git } from "../../test/repos.ts";
import type { ButBoard, ButBranch } from "./parse.ts";
import { compareWithRemotes, countSides, trackingRefs, upstreamLoss } from "./upstream.ts";

const env = await isolate("source-control-upstream");
const signal = new AbortController().signal;
let repository = "";

async function commitFile(name: string, text: string): Promise<string> {
  await writeFile(join(repository, name), text);
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", `change ${name}`);
  return git(repository, "rev-parse", "HEAD").trim();
}

/** A branch as `but status` reports it: needing force, with `upstream` remote commits. */
function branch(name: string, upstream: number): ButBranch {
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
    commits: [commit],
    upstreamCommits: Array.from({ length: upstream }, () => commit),
    newUpstream: upstream,
  };
}

function workspaceOf(...branches: ButBranch[]): ButBoard {
  return {
    unassignedChanges: [],
    stacks: branches.map((entry) => ({ key: entry.name, branches: [entry], assignedChanges: [] })),
    base: null,
    upstream: null,
    conflictedFiles: [],
  };
}

async function compared(name: string, upstream: number) {
  const [stack] = (
    await compareWithRemotes(repository, workspaceOf(branch(name, upstream)), signal)
  ).stacks;
  return stack!.branches[0];
}

beforeAll(async () => {
  repository = join(env.root, "repository");
  git(env.root, "init", "--quiet", "--initial-branch=main", repository);
  // `fork` lists before `origin`, so comparing with origin follows the setting, not luck.
  git(repository, "remote", "add", "fork", "https://example.com/fork.git");
  git(repository, "remote", "add", "origin", "https://example.com/origin.git");
  git(repository, "config", "gitbutler.project.pushremote", "origin");
  const base = await commitFile("base.txt", "base\n");

  // Behind: the remote went on from the local head, which has nothing new.
  const behindRemote = await commitFile("behind.txt", "from another machine\n");
  git(repository, "branch", "scott/behind", base);
  git(repository, "update-ref", "refs/remotes/origin/scott/behind", behindRemote);
  // A remote that lacks the branch's head entirely must not be the one compared.
  git(repository, "update-ref", "refs/remotes/fork/scott/behind", base);

  // Diverged: each side has a commit the other lacks.
  git(repository, "checkout", "--quiet", "-b", "scott/diverged", base);
  await commitFile("local.txt", "local\n");
  git(repository, "checkout", "--quiet", "--detach", base);
  git(
    repository,
    "update-ref",
    "refs/remotes/origin/scott/diverged",
    await commitFile("remote.txt", "x\n"),
  );

  // Rebased: the remote holds the old copy of the branch's one commit.
  git(repository, "checkout", "--quiet", "--detach", base);
  const old = await commitFile("feature.txt", "feature\n");
  git(repository, "update-ref", "refs/remotes/origin/scott/rebased", old);
  git(repository, "checkout", "--quiet", "--detach", base);
  await commitFile("main.txt", "main moved on\n");
  await writeFile(join(repository, "feature.txt"), "feature\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "change feature.txt");
  git(repository, "branch", "scott/rebased", "HEAD");

  // Tracks fork, where new work landed. origin holds only an old copy.
  git(repository, "branch", "scott/forked", "scott/rebased");
  git(repository, "config", "branch.scott/forked.remote", "fork");
  git(repository, "config", "branch.scott/forked.merge", "refs/heads/scott/forked");
  git(repository, "update-ref", "refs/remotes/origin/scott/forked", old);
  git(repository, "checkout", "--quiet", "scott/rebased");
  git(
    repository,
    "update-ref",
    "refs/remotes/fork/scott/forked",
    await commitFile("forked.txt", "landed on the fork\n"),
  );
  git(repository, "checkout", "--quiet", "main");
});

afterAll(async () => {
  await env.cleanup();
});

test("a branch only behind its remote reads as behind, with nothing to push", async () => {
  expect(await compared("scott/behind", 1)).toMatchObject({
    status: "behind",
    push: "none",
    newUpstream: 1,
  });
});

test("a diverged branch keeps its force push, with the remote's commit counted as new", async () => {
  expect(await compared("scott/diverged", 1)).toMatchObject({
    status: "diverged",
    push: "force",
    newUpstream: 1,
  });
});

test("old copies of a rebased branch's commits are upstream, but nothing new", async () => {
  expect(await compared("scott/rebased", 1)).toMatchObject({
    status: "diverged",
    push: "force",
    newUpstream: 0,
  });
});

test("a branch with no remote-tracking ref keeps what GitButler said", async () => {
  expect(await compared("scott/nowhere", 2)).toEqual(branch("scott/nowhere", 2));
});

test("a branch git tracks on another remote is compared with that remote", async () => {
  expect(await compared("scott/forked", 1)).toMatchObject({
    status: "behind",
    push: "none",
    newUpstream: 1,
  });
  expect(await trackingRefs(repository, ["scott/forked", "scott/behind"], signal)).toEqual(
    new Map([
      ["scott/forked", "refs/remotes/fork/scott/forked"],
      ["scott/behind", "refs/remotes/origin/scott/behind"],
    ]),
  );
});

test("countSides counts each side of a cherry-marked comparison, equivalents aside", () => {
  expect(countSides("<a\n<b\n>c\n=d\n")).toEqual({ local: 2, remote: 1 });
});

test("a push deletes the new upstream commits of the branch and every branch below it", () => {
  const top = { ...branch("top", 1), newUpstream: 1 };
  const copies = { ...branch("copies", 1), newUpstream: 0 };
  top.upstreamCommits = [{ ...top.upstreamCommits[0]!, commitId: "a".repeat(40) }];
  expect(upstreamLoss([top, copies])).toEqual(["a".repeat(40)]);
});
