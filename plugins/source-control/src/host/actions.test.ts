/**
 * The GitButler provider's writes against a scripted `but`, in a real
 * repository: a pull reads the target's new commits from git, and a push
 * compares the branch with its remote there. Ported from
 * `plugins/gitbutler/src/host/actions.test.ts` (push, the workspace pull, land and delete).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import type { ActionRisk } from "../core/change.ts";
import { fakeBut, scriptedBut, turns } from "../../test/fake-but.ts";
import { isolate } from "../../test/isolate.ts";
import { git } from "../../test/repos.ts";
import { runButWrite } from "./actions.ts";

const env = await isolate("source-control-actions");
const signal = new AbortController().signal;
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const undo of cleanup.reverse()) await undo();
  cleanup = [];
});

async function script(answers: Record<string, unknown>) {
  const { calls, restore } = await scriptedBut(answers);
  cleanup.push(restore);
  return calls;
}

/**
 * scott/top has one commit, and origin one more on top of it. scott/bottom
 * has one commit, and origin one more.
 */
let repository = "";
const sha: Record<string, string> = {};

async function commitFile(name: string): Promise<string> {
  await writeFile(join(repository, name), `${name}\n`);
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", name);
  return git(repository, "rev-parse", "HEAD").trim();
}

beforeAll(async () => {
  repository = join(env.root, "repository");
  git(env.root, "init", "--quiet", "--initial-branch=main", repository);
  git(repository, "config", "gitbutler.project.pushremote", "origin");
  const base = await commitFile("base.txt");
  for (const [branch, local, remote] of [
    ["scott/top", "top.txt", "remote.txt"],
    ["scott/bottom", "bottom.txt", "bottom-remote.txt"],
  ] as const) {
    git(repository, "checkout", "--quiet", "-b", branch, base);
    sha[branch] = await commitFile(local);
    sha[`${branch}@remote`] = await commitFile(remote);
    git(repository, "update-ref", `refs/remotes/origin/${branch}`, sha[`${branch}@remote`]!);
    git(repository, "reset", "--quiet", "--hard", sha[branch]!);
  }
  git(repository, "checkout", "--quiet", "main");
});

afterAll(async () => {
  await env.cleanup();
});

/** `but status -u --json` for the repository, with `upstream` remote commits on scott/top. */
function statusWith(upstream: number, uncommitted: string[] = []) {
  const commit = (id: string, cliId: string) => ({
    cliId,
    commitId: id,
    changeId: "same",
    conflicted: false,
  });
  return {
    uncommittedChanges: uncommitted.map((filePath) => ({ filePath, changeType: "modified" })),
    stacks: [
      {
        branches: [
          {
            name: "scott/top",
            cliId: "to",
            branchStatus: "unpushedCommitsRequiringForce",
            commits: [commit(sha["scott/top"]!, "abc")],
            upstreamCommits: Array.from({ length: upstream }, () =>
              commit(sha["scott/top@remote"]!, "rem"),
            ),
          },
          {
            name: "scott/bottom",
            cliId: "bo",
            branchStatus: "unpushedCommitsRequiringForce",
            commits: [commit(sha["scott/bottom"]!, "def")],
            upstreamCommits: [commit(sha["scott/bottom@remote"]!, "bre")],
          },
        ],
      },
    ],
  };
}

const CHECK_CLEAN = { branchStatuses: [], upToDate: false, hasWorktreeConflicts: false };

test("a write refuses a branch whose name is also another item's id", async () => {
  // Observed on but 0.22.3: `but branch delete fi` deleted the branch whose id was fi.
  const status = statusWith(0);
  status.stacks[0]!.branches[0]!.commits[0]!.cliId = "scott/bottom";
  const calls = await script({ "pull --check": CHECK_CLEAN, "status -u": status });
  const push = { kind: "push" as const, branch: "scott/bottom", force: false, acceptedLoss: [] };
  await expect(runButWrite(repository, push, signal)).rejects.toThrow(
    "GitButler also uses scott/bottom as the id of something else",
  );
  expect(await calls()).toEqual(["pull --check --json", "status -u --json"]);
});

test("Push fetches, then asks about every upstream commit it would delete that the reader did not agree to", async () => {
  // origin has one new commit on scott/top and one on scott/bottom, which `but push` forces along.
  const calls = await script({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(1),
    "push scott/top --with-force": "{}",
  });
  const push = (acceptedLoss: string[]) =>
    ({ kind: "push", branch: "scott/top", force: true, acceptedLoss }) as const;
  const both = [sha["scott/top@remote"]!, sha["scott/bottom@remote"]!];
  const asked = { status: "confirm", risk: null, loss: both };
  // Agreed to scott/top's, but scott/bottom's goes too.
  expect(await runButWrite(repository, push([sha["scott/top@remote"]!]), signal)).toEqual(asked);
  // As many commits as were agreed to, but not the same ones: the remote was rewritten.
  expect(await runButWrite(repository, push(["a".repeat(40), "b".repeat(40)]), signal)).toEqual(
    asked,
  );
  expect(await calls()).not.toContain("push scott/top --with-force --json");

  expect(await runButWrite(repository, push(both), signal)).toEqual({ status: "done" });
  expect((await calls()).slice(-3)).toEqual([
    "pull --check --json",
    "status -u --json",
    "push scott/top --with-force --json",
  ]);
});

const update = (accepted: ActionRisk | null = null) => ({ kind: "pull", accepted }) as const;

test("the workspace pull goes straight through when nothing would conflict", async () => {
  const calls = await script({ "pull --check": CHECK_CLEAN, pull: "{}" });
  expect(await runButWrite(repository, update(), signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual(["pull --check --json", "pull --json"]);
});

test("the workspace pull asks about conflicts and overlapping work, and again about more", async () => {
  const calls = await script({
    "pull --check": {
      branchStatuses: [
        { name: "scott/top", status: "conflicted", rebasable: true },
        { name: "scott/bottom", status: "conflicted", rebasable: true },
      ],
      upToDate: false,
      hasWorktreeConflicts: true,
    },
    pull: "{}",
  });
  const risk = { conflicted: ["scott/top", "scott/bottom"], overlapsUncommitted: true };
  expect(await runButWrite(repository, update(), signal)).toEqual({
    status: "confirm",
    risk,
    loss: null,
  });
  const partly = { conflicted: ["scott/top", "scott/bottom"], overlapsUncommitted: false };
  expect(await runButWrite(repository, update(partly), signal)).toEqual({
    status: "confirm",
    risk,
    loss: null,
  });
  expect(await calls()).not.toContain("pull --json");
  expect(await runButWrite(repository, update(risk), signal)).toEqual({ status: "done" });
  expect((await calls()).at(-1)).toBe("pull --json");
});

test("the workspace pull says so when the remote has nothing new", async () => {
  const calls = await script({
    "pull --check": { branchStatuses: [], upToDate: true, hasWorktreeConflicts: false },
  });
  expect(await runButWrite(repository, update(), signal)).toEqual({ status: "upToDate" });
  expect(await calls()).toEqual(["pull --check --json"]);
});

test("a write blocked by files still holding conflict markers says so plainly", async () => {
  cleanup.push(
    await fakeBut(
      'echo "Error: unresolved conflicts exist in the index; class=Checkout (20); code=Conflict (-13)" >&2; exit 1',
    ),
  );
  await expect(runButWrite(repository, update(), signal)).rejects.toThrow(
    "Files still hold conflict markers. Resolve them in your editor or GitButler, then try again.",
  );
});

test("a fetch that cannot reach the remote reads as git's reason, not its argv dump", async () => {
  // Trimmed from but 0.22.3 with an unreadable remote.
  const directory = await mkdtemp(join(tmpdir(), "source-control-fetch-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const stderr = join(directory, "stderr");
  await writeFile(
    stderr,
    [
      "Error: origin: backend error: git command exited with non-zero exit code 128:",
      "ARGS: fetch origin",
      "STDOUT:",
      "STDERR:",
      "fatal: '/tmp/origin.git' does not appear to be a git repository",
      "fatal: Could not read from remote repository.",
      "",
    ].join("\n"),
  );
  cleanup.push(await fakeBut(`cat '${stderr}' >&2; exit 1`));
  await expect(runButWrite(repository, update(), signal)).rejects.toThrow(
    "Could not reach the remote. '/tmp/origin.git' does not appear to be a git repository Could not read from remote repository.",
  );
});

/** A pull check after its fetch, with the target branch at `target`. */
const checkAt = (target: string) => ({
  ...CHECK_CLEAN,
  baseBranch: { name: "origin/main", currentSha: target },
});

/** `but status -u --json` with scott/top holding `commits`, newest first, alone in its stack unless stacked. */
function statusOfTop(commits: string[], { stacked = false } = {}) {
  const status = statusWith(0);
  const [top] = status.stacks[0]!.branches;
  top!.commits = commits.map((commitId, index) => ({
    cliId: `c${index}`,
    commitId,
    changeId: `change${index}`,
    conflicted: false,
  }));
  if (!stacked) status.stacks[0]!.branches.splice(1);
  return status;
}

const land = (message: string | null, accepted: ActionRisk | null = null) => ({
  kind: "land" as const,
  branch: "scott/top",
  message,
  accepted,
});
const TWO = () => [sha["scott/top@remote"]!, sha["scott/top"]!];
const MESSAGE = "feat: top and remote";
const main = () => git(repository, "rev-parse", "main").trim();

test("Land squashes a branch of several commits into one, then lands it", async () => {
  const calls = await script({
    "pull --check": checkAt(main()),
    "status -u": statusOfTop(TWO()),
    [`squash scott/top --message=${MESSAGE}`]: "{}",
    "land scott/top --yes": "{}",
  });
  expect(await runButWrite(repository, land(MESSAGE), signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual([
    "pull --check --json",
    "status -u --json",
    `squash scott/top --message=${MESSAGE} --json`,
    "land scott/top --yes --json",
  ]);
});

test("Land lands a branch of one commit as it is", async () => {
  const calls = await script({
    "pull --check": checkAt(main()),
    "status -u": statusOfTop([sha["scott/top"]!]),
    "land scott/top --yes": "{}",
  });
  expect(await runButWrite(repository, land(null), signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual([
    "pull --check --json",
    "status -u --json",
    "land scott/top --yes --json",
  ]);
});

/**
 * A target with scott/bottom's commit, which scott/top lacks, and scott/top
 * as the pull leaves it: scott/bottom's remote commits stand in for scott/top's
 * two rebased onto that target.
 */
const BEHIND = () => checkAt(sha["scott/bottom"]!);
const PULLED = () => statusOfTop([sha["scott/bottom@remote"]!, sha["scott/bottom"]!]);

test("Land pulls a branch behind the target up to it, then squashes and lands it", async () => {
  const calls = await script({
    "pull --check": BEHIND(),
    "status -u": turns(statusOfTop(TWO()), PULLED()),
    pull: "{}",
    [`squash scott/top --message=${MESSAGE}`]: "{}",
    "land scott/top --yes": "{}",
  });
  expect(await runButWrite(repository, land(MESSAGE), signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual([
    "pull --check --json",
    "status -u --json",
    "pull --json",
    "status -u --json",
    `squash scott/top --message=${MESSAGE} --json`,
    "land scott/top --yes --json",
  ]);
});

test("Land asks before a pull that leaves conflicts elsewhere", async () => {
  const risk = { conflicted: ["scott/other"], overlapsUncommitted: true };
  const calls = await script({
    "pull --check": {
      ...BEHIND(),
      branchStatuses: [{ name: "scott/other", status: "conflicted" }],
      hasWorktreeConflicts: true,
    },
    "status -u": statusOfTop(TWO()),
  });
  expect(await runButWrite(repository, land(MESSAGE), signal)).toEqual({
    status: "confirm",
    risk,
    loss: null,
  });
  expect(await calls()).toEqual(["pull --check --json", "status -u --json"]);
});

test("Land refuses, before changing anything, a branch the pull would leave conflicted", async () => {
  const calls = await script({
    "pull --check": { ...BEHIND(), branchStatuses: [{ name: "scott/top", status: "conflicted" }] },
    "status -u": statusOfTop(TWO()),
  });
  await expect(runButWrite(repository, land(MESSAGE), signal)).rejects.toThrow(
    "Land stopped before changing anything: scott/top conflicts with the new commits on origin/main. Pull the workspace, resolve the conflicts, then land it.",
  );
  expect(await calls()).toEqual(["pull --check --json", "status -u --json"]);
});

test("Land stops after the pull when the branch is still behind the target", async () => {
  await script({ "pull --check": BEHIND(), "status -u": statusOfTop(TWO()), pull: "{}" });
  await expect(runButWrite(repository, land(MESSAGE), signal)).rejects.toThrow(
    "Land pulled the workspace, then stopped: scott/top is still a commit behind origin/main, so `but land` would merge it. Land it again.",
  );
});

test("Land stops after a pull that took commits the target already has, before squashing the rest", async () => {
  await script({
    "pull --check": BEHIND(),
    "status -u": turns(statusOfTop(TWO()), statusOfTop([sha["scott/bottom@remote"]!])),
    pull: "{}",
  });
  await expect(runButWrite(repository, land(MESSAGE), signal)).rejects.toThrow(
    "Land pulled the workspace, then stopped: the target already had one of scott/top's 2 commits, so the pull took it out. Land it again to land the rest.",
  );
});

test("a land that fails after the squash says the branch stays squashed", async () => {
  await script({
    "pull --check": checkAt(main()),
    "status -u": statusOfTop(TWO()),
    [`squash scott/top --message=${MESSAGE}`]: "{}",
  });
  await expect(runButWrite(repository, land(MESSAGE), signal)).rejects.toThrow(
    " scott/top is now one squashed commit. If the target does not have it yet, land it again.",
  );
});

test.each([
  {
    name: "a branch that gained commits after it was chosen with one",
    status: () => statusOfTop(TWO()),
    message: null,
    refusal:
      "scott/top has more commits than when you chose Land. Land it again to write their squashed message.",
  },
  {
    name: "a branch that now has another branch below it",
    status: () => statusOfTop(TWO(), { stacked: true }),
    message: MESSAGE,
    refusal: "scott/top has a branch below it now, and only the lowest branch of a stack can land.",
  },
  {
    name: "a squash message when the branch is down to one commit",
    status: () => statusOfTop([sha["scott/top"]!]),
    message: MESSAGE,
    refusal:
      "scott/top is down to one commit since you chose Land. Land it again to land that commit as it is.",
  },
])("Land refuses $name, before changing anything", async ({ status, message, refusal }) => {
  const calls = await script({ "pull --check": checkAt(main()), "status -u": status() });
  await expect(runButWrite(repository, land(message), signal)).rejects.toThrow(
    `Land stopped before changing anything: ${refusal}`,
  );
  expect(await calls()).toEqual(["pull --check --json", "status -u --json"]);
});

test("Delete runs straight away when no uncommitted change is in the branch's files", async () => {
  const calls = await script({
    "status -u": statusWith(0, ["notes.md"]),
    "branch delete scott/top": "{}",
  });
  const action = { kind: "delete" as const, branch: "scott/top", accepted: null };
  expect(await runButWrite(repository, action, signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual(["status -u --json", "branch delete scott/top --json"]);
});

test("Delete asks first when uncommitted changes are in files the branch changed", async () => {
  const calls = await script({
    "status -u": statusWith(0, ["top.txt"]),
    "branch delete scott/top": "{}",
  });
  const risk: ActionRisk = { conflicted: [], overlapsUncommitted: true };
  const action = { kind: "delete" as const, branch: "scott/top", accepted: null };
  expect(await runButWrite(repository, action, signal)).toEqual({
    status: "confirm",
    risk,
    loss: null,
  });
  expect(await calls()).toEqual(["status -u --json"]);
  expect(await runButWrite(repository, { ...action, accepted: risk }, signal)).toEqual({
    status: "done",
  });
});
