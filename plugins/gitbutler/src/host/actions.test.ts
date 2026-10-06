import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeBut } from "../../test/fake-but.ts";
import type { ActionRisk } from "../shared/schema.ts";
import { actionArgs, runAction } from "./actions.ts";
import { runGit } from "./cli.ts";

test("push names the branch and forces only when asked", () => {
  expect(actionArgs({ kind: "push", branch: "scott/top", force: false, acceptedLoss: [] })).toEqual(
    ["push", "scott/top"],
  );
  expect(actionArgs({ kind: "push", branch: "scott/top", force: true, acceptedLoss: [] })).toEqual([
    "push",
    "scott/top",
    "--with-force",
  ]);
});

test("land skips the CLI's confirmation and rename rewords the branch", () => {
  expect(actionArgs({ kind: "land", branch: "scott/top" })).toEqual(["land", "scott/top", "--yes"]);
  expect(actionArgs({ kind: "rename", branch: "scott/top", name: "scott/better" })).toEqual([
    "reword",
    "scott/top",
    "-m",
    "scott/better",
  ]);
});

test("delete goes through `branch delete`, not `discard`, which also takes files", () => {
  expect(actionArgs({ kind: "delete", branch: "zz", accepted: null })).toEqual([
    "branch",
    "delete",
    "zz",
  ]);
});

const signal = new AbortController().signal;
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const undo of cleanup.reverse()) await undo();
  cleanup = [];
});

/**
 * A `but` that answers each argv from `answers` and logs every call. An argv
 * it was not given fails the way `but` refuses, so a call the flow should not
 * make shows up as an error or in the log.
 */
async function scriptedBut(answers: Record<string, unknown>): Promise<() => Promise<string[]>> {
  const directory = await mkdtemp(join(tmpdir(), "gitbutler-scripted-"));
  const cases = await Promise.all(
    Object.entries(answers).map(async ([argv], index) => {
      const file = join(directory, `${index}.out`);
      const answer = answers[argv];
      await writeFile(file, typeof answer === "string" ? answer : JSON.stringify(answer));
      return `  "${argv} --json") cat '${file}' ;;`;
    }),
  );
  const log = join(directory, "calls.log");
  const restore = await fakeBut(
    [
      `echo "$*" >> '${log}'`,
      'case "$*" in',
      ...cases,
      '  *) echo "Error: unexpected $*" >&2; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
  cleanup.push(async () => {
    await restore();
    await rm(directory, { recursive: true, force: true });
  });
  return async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
}

/**
 * A real repository, because a pull reads the remote's new commits from git
 * and a delete reads the files its branch touched. scott/top has one commit,
 * and origin one more on top of it. scott/bottom has one commit, and origin
 * one more. scott/copied's remote holds only an old copy of its commit.
 */
let repository = "";
const sha: Record<string, string> = {};

async function commitFile(name: string): Promise<string> {
  await writeFile(join(repository, name), `${name}\n`);
  await runGit(repository, ["add", "--all"], signal);
  await runGit(repository, ["commit", "--quiet", "-m", name], signal);
  return (await runGit(repository, ["rev-parse", "HEAD"], signal)).trim();
}

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), "gitbutler-actions-"));
  const git = (...args: string[]) => runGit(repository, args, signal);
  await git("init", "--quiet", "--initial-branch=main", ".");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test Person");
  await git("config", "commit.gpgsign", "false");
  await git("config", "gitbutler.project.pushremote", "origin");
  const base = await commitFile("base.txt");
  for (const [branch, local, remote] of [
    ["scott/top", "top.txt", "remote.txt"],
    ["scott/bottom", "bottom.txt", "bottom-remote.txt"],
  ] as const) {
    await git("checkout", "--quiet", "-b", branch, base);
    sha[branch] = await commitFile(local);
    sha[`${branch}@remote`] = await commitFile(remote);
    await git("update-ref", `refs/remotes/origin/${branch}`, sha[`${branch}@remote`]!);
    await git("reset", "--quiet", "--hard", sha[branch]!);
  }
  await git("checkout", "--quiet", "-b", "scott/copied", base);
  const old = await commitFile("copied.txt");
  await git("update-ref", "refs/remotes/origin/scott/copied", old);
  await git("reset", "--quiet", "--hard", base);
  await commitFile("moved-on.txt");
  await writeFile(join(repository, "copied.txt"), "copied.txt\n");
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "copied.txt");
  sha["scott/copied"] = (await git("rev-parse", "HEAD")).trim();

  // A merge whose resolution adds a file neither side had.
  await git("checkout", "--quiet", "-b", "scott/merged", base);
  await commitFile("left.txt");
  await git("merge", "--quiet", "--no-ff", "--no-commit", sha["scott/top"]!);
  await writeFile(join(repository, "resolved.txt"), "resolved.txt\n");
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "merge");
  sha["scott/merged"] = (await git("rev-parse", "HEAD")).trim();
  await git("checkout", "--quiet", "main");
});

afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
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
    uncommittedChanges: uncommitted.map((filePath, index) => ({
      cliId: `u${index}`,
      filePath,
      changeType: "modified",
    })),
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

/** A dry run's preview: each branch's commits, and the commits it rewrote. */
function preview(
  segments: Record<string, [string, boolean?][]>,
  replaced: Record<string, string> = {},
) {
  return {
    workspace: {
      replacedCommits: replaced,
      headInfo: {
        stacks: [
          {
            segments: Object.entries(segments).map(([name, commits]) => ({
              refName: { displayName: name },
              commits: commits.map(([id, hasConflicts = false]) => ({ id, hasConflicts })),
            })),
          },
        ],
      },
    },
  };
}

/** scott/top's commit rebased onto origin's, as the dry run reports it. */
const REBASED = "e".repeat(40);

function cleanPullOfTop(conflicted = false) {
  return preview(
    {
      "scott/top": [[sha["scott/top@remote"]!], [REBASED, conflicted]],
      "scott/bottom": [[sha["scott/bottom"]!]],
    },
    { [sha["scott/top"]!]: REBASED },
  );
}

const CHECK_CLEAN = { branchStatuses: [], upToDate: false, hasWorktreeConflicts: false };
const pull = (accepted: ActionRisk | null = null) =>
  ({ kind: "pull", branch: "scott/top", accepted }) as const;

test("Pull fetches, previews, and only then updates the branch", async () => {
  const calls = await scriptedBut({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(1),
    "branch update scott/top --dry-run": cleanPullOfTop(),
    "branch update scott/top": "{}",
  });
  expect(await runAction(repository, pull(), signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual([
    "pull --check --json",
    "status -u --json",
    "branch update scott/top --dry-run --json",
    "branch update scott/top --json",
  ]);
});

test("Pull refuses, before changing anything, when GitButler would move another branch's commits", async () => {
  // Observed on but 0.22.3: updating the lower branch of a stack took the upper one's commit.
  const calls = await scriptedBut({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(0),
    "branch update scott/bottom --dry-run": preview({
      "scott/top": [],
      "scott/bottom": [[sha["scott/top"]!], [sha["scott/bottom@remote"]!], [sha["scott/bottom"]!]],
    }),
  });
  const action = { kind: "pull" as const, branch: "scott/bottom", accepted: null };
  const failure = await runAction(repository, action, signal).catch((error: Error) => error);
  expect((failure as Error).message).toBe(
    "Pull stopped before changing anything: GitButler would move commits from scott/top into scott/bottom.",
  );
  expect(await calls()).toEqual([
    "pull --check --json",
    "status -u --json",
    "branch update scott/bottom --dry-run --json",
  ]);
});

test("Pull asks before leaving conflicts, and the retry that accepted them updates", async () => {
  const calls = await scriptedBut({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(1),
    "branch update scott/top --dry-run": cleanPullOfTop(true),
    "branch update scott/top": "{}",
  });
  const risk = { conflicted: ["scott/top"], overlapsUncommitted: false };
  expect(await runAction(repository, pull(), signal)).toEqual({ status: "confirm", risk });
  expect(await calls()).not.toContain("branch update scott/top --json");

  expect(await runAction(repository, pull(risk), signal)).toEqual({ status: "done" });
  expect((await calls()).at(-1)).toBe("branch update scott/top --json");
});

test("Pull asks when uncommitted changes sit in a file the remote's commits change", async () => {
  const calls = await scriptedBut({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(1, ["notes.md", "remote.txt"]),
    "branch update scott/top --dry-run": cleanPullOfTop(),
    "branch update scott/top": "{}",
  });
  expect(await runAction(repository, pull(), signal)).toEqual({
    status: "confirm",
    risk: { conflicted: [], overlapsUncommitted: true },
  });
  // Agreeing to conflicted commits is not agreeing to conflict markers in files.
  const other = { conflicted: ["scott/top"], overlapsUncommitted: false };
  expect((await runAction(repository, pull(other), signal)).status).toBe("confirm");
  expect(await calls()).not.toContain("branch update scott/top --json");
});

test("Pull goes ahead when the uncommitted changes are in other files", async () => {
  await scriptedBut({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(1, ["top.txt", "notes.md"]),
    "branch update scott/top --dry-run": cleanPullOfTop(),
    "branch update scott/top": "{}",
  });
  expect(await runAction(repository, pull(), signal)).toEqual({ status: "done" });
});

test("Pull changes nothing when the fetch found nothing new, or only old copies", async () => {
  const calls = await scriptedBut({ "pull --check": CHECK_CLEAN, "status -u": statusWith(0) });
  expect(await runAction(repository, pull(), signal)).toEqual({ status: "upToDate" });
  expect(await calls()).toEqual(["pull --check --json", "status -u --json"]);

  const copied = {
    stacks: [
      {
        branches: [
          {
            name: "scott/copied",
            branchStatus: "unpushedCommitsRequiringForce",
            commits: [{ commitId: sha["scott/copied"] }],
            upstreamCommits: [{ commitId: "f".repeat(40) }],
          },
        ],
      },
    ],
  };
  await scriptedBut({ "pull --check": CHECK_CLEAN, "status -u": copied });
  const action = { kind: "pull" as const, branch: "scott/copied", accepted: null };
  expect(await runAction(repository, action, signal)).toEqual({ status: "upToDate" });
});

test("Delete runs straight away when no uncommitted change is in the branch's files", async () => {
  const calls = await scriptedBut({
    "status -u": statusWith(0, ["notes.md"]),
    "branch delete scott/top": "{}",
  });
  const action = { kind: "delete" as const, branch: "scott/top", accepted: null };
  expect(await runAction(repository, action, signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual(["status -u --json", "branch delete scott/top --json"]);
});

test("Delete asks first when uncommitted changes are in files the branch changed", async () => {
  const calls = await scriptedBut({
    "status -u": statusWith(0, ["top.txt"]),
    "branch delete scott/top": "{}",
  });
  const risk = { conflicted: [], overlapsUncommitted: true };
  const action = { kind: "delete" as const, branch: "scott/top", accepted: null };
  expect(await runAction(repository, action, signal)).toEqual({ status: "confirm", risk });
  expect(await calls()).toEqual(["status -u --json"]);
  expect(await runAction(repository, { ...action, accepted: risk }, signal)).toEqual({
    status: "done",
  });
});

test("a write refuses a branch whose name is also another item's id", async () => {
  // Observed on but 0.22.3: `but branch delete fi` deleted the branch whose id was fi.
  const status = statusWith(0);
  status.stacks[0]!.branches[0]!.commits[0]!.cliId = "scott/bottom";
  const calls = await scriptedBut({ "status -u": status });
  const action = { kind: "delete" as const, branch: "scott/bottom", accepted: null };
  const failure = await runAction(repository, action, signal).catch((error: Error) => error);
  expect((failure as Error).message).toContain(
    "GitButler also uses scott/bottom as the id of something else",
  );
  expect(await calls()).toEqual(["status -u --json"]);
});

test("Push fetches, then stops on any upstream commit the reader did not agree to delete", async () => {
  // origin has one new commit on scott/top and one on scott/bottom, which `but push` forces along.
  const calls = await scriptedBut({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(1),
    "push scott/top --with-force": "{}",
  });
  const push = (acceptedLoss: string[]) =>
    ({ kind: "push", branch: "scott/top", force: true, acceptedLoss }) as const;
  const stopped =
    "Push stopped: the remote has commits this push would delete that you were not asked about. Look at them, then push again.";
  // Agreed to scott/top's, but scott/bottom's goes too.
  const partial = await runAction(repository, push([sha["scott/top@remote"]!]), signal).catch(
    (error: Error) => error,
  );
  expect((partial as Error).message).toBe(stopped);
  // As many commits as were agreed to, but not the same ones: the remote was rewritten.
  const other = await runAction(repository, push(["a".repeat(40), "b".repeat(40)]), signal).catch(
    (error: Error) => error,
  );
  expect((other as Error).message).toBe(stopped);
  expect(await calls()).not.toContain("push scott/top --with-force --json");

  const both = [sha["scott/top@remote"]!, sha["scott/bottom@remote"]!];
  expect(await runAction(repository, push(both), signal)).toEqual({ status: "done" });
  expect((await calls()).slice(-3)).toEqual([
    "pull --check --json",
    "status -u --json",
    "push scott/top --with-force --json",
  ]);
});

test("Delete counts a merge's own changes as the branch's files", async () => {
  const status = statusWith(0, ["resolved.txt"]);
  status.stacks[0]!.branches[0]!.commits = [
    { cliId: "mrg", commitId: sha["scott/merged"]!, changeId: "same", conflicted: false },
  ];
  await scriptedBut({ "status -u": status });
  const action = { kind: "delete" as const, branch: "scott/top", accepted: null };
  expect(await runAction(repository, action, signal)).toEqual({
    status: "confirm",
    risk: { conflicted: [], overlapsUncommitted: true },
  });
});

const update = (accepted: ActionRisk | null = null) =>
  ({ kind: "updateWorkspace", accepted }) as const;

test("the workspace pull goes straight through when nothing would conflict", async () => {
  const calls = await scriptedBut({
    "pull --check": CHECK_CLEAN,
    "status -u": statusWith(0),
    pull: "{}",
  });
  expect(await runAction(repository, update(), signal)).toEqual({ status: "done" });
  expect(await calls()).toEqual(["pull --check --json", "pull --json"]);
});

test("the workspace pull asks about conflicts and overlapping work, and again about more", async () => {
  const calls = await scriptedBut({
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
  expect(await runAction(repository, update(), signal)).toEqual({ status: "confirm", risk });
  const partly = { conflicted: ["scott/top", "scott/bottom"], overlapsUncommitted: false };
  expect(await runAction(repository, update(partly), signal)).toEqual({
    status: "confirm",
    risk,
  });
  expect(await calls()).not.toContain("pull --json");
  expect(await runAction(repository, update(risk), signal)).toEqual({ status: "done" });
  expect((await calls()).at(-1)).toBe("pull --json");
});

test("the workspace pull says so when the remote has nothing new", async () => {
  const calls = await scriptedBut({
    "pull --check": { branchStatuses: [], upToDate: true, hasWorktreeConflicts: false },
  });
  expect(await runAction(repository, update(), signal)).toEqual({ status: "upToDate" });
  expect(await calls()).toEqual(["pull --check --json"]);
});

test("a write blocked by files still holding conflict markers says so plainly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitbutler-markers-"));
  await writeFile(join(directory, "status.json"), JSON.stringify(statusWith(0)));
  const restore = await fakeBut(
    [
      'case "$*" in',
      `  "status -u --json") cat '${join(directory, "status.json")}' ;;`,
      '  *) echo "Error: unresolved conflicts exist in the index; class=Checkout (20); code=Conflict (-13)" >&2; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
  cleanup.push(async () => {
    await restore();
    await rm(directory, { recursive: true, force: true });
  });
  const action = { kind: "delete" as const, branch: "scott/bottom", accepted: null };
  const failure = await runAction(repository, action, signal).catch((error: Error) => error);
  expect((failure as Error).message).toBe(
    "Files still hold conflict markers. Resolve them in your editor or GitButler, then try again.",
  );
});

test("a fetch that cannot reach the remote reads as git's reason, not its argv dump", async () => {
  // Trimmed from but 0.22.3 with an unreadable remote.
  const directory = await mkdtemp(join(tmpdir(), "gitbutler-fetch-"));
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
  const restore = await fakeBut(`cat '${stderr}' >&2; exit 1`);
  cleanup.push(async () => {
    await restore();
    await rm(directory, { recursive: true, force: true });
  });
  const failure = await runAction(repository, update(), signal).catch((error: Error) => error);
  expect((failure as Error).message).toBe(
    "Could not reach the remote. '/tmp/origin.git' does not appear to be a git repository Could not read from remote repository.",
  );
});
