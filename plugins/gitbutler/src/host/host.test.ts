import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { fakeBut } from "../../test/fake-but.ts";
import { branchListPayload, oplogPayload, statusPayload } from "../../test/fixtures.ts";
import { runGit } from "./cli.ts";
import hostEntry from "./host.ts";

const signal = new AbortController().signal;
const host = experimental_createHostEntryHarness(hostEntry);
let scratch = "";
let repository = "";
let log = "";
let restore: (() => Promise<void>) | undefined;

/** Every `but` argv, one call per line, in the order the host made them. */
async function butCalls(): Promise<string[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

/**
 * A `but` that logs its argv and answers each read from a real payload, and
 * fails `but diff` the way it does for a commit outside the workspace.
 */
async function answering(payloads: { branchList?: unknown; oplog?: unknown }) {
  const answers = join(scratch, "answers");
  await mkdir(answers, { recursive: true });
  await writeFile(join(answers, "status.json"), JSON.stringify(statusPayload));
  await writeFile(join(answers, "branch.json"), JSON.stringify(payloads.branchList ?? {}));
  await writeFile(join(answers, "oplog.json"), JSON.stringify(payloads.oplog ?? []));
  restore = await fakeBut(
    [
      `printf '%s\\n' "$*" >> '${log}'`,
      `case "$1 $2" in`,
      `  "status -u") cat '${answers}/status.json' ;;`,
      `  "branch list") cat '${answers}/branch.json' ;;`,
      `  "oplog list") cat '${answers}/oplog.json' ;;`,
      `  *) printf "Error: Could not find target: '%s'\\n" "$2" >&2; exit 1 ;;`,
      `esac`,
    ].join("\n"),
  );
}

/**
 * A `but` whose every call takes a moment and logs when it starts and ends,
 * after the directory it ran in, so calls that overlap show in the log. The
 * workspace update finds nothing in its way, and `status -u` fails.
 */
async function slowActions() {
  restore = await fakeBut(
    [
      `call="$(basename "$(pwd)") $*"`,
      `printf 'start %s\\n' "$call" >> '${log}'`,
      `sleep 0.2`,
      `printf 'end %s\\n' "$call" >> '${log}'`,
      `case "$1 $2" in`,
      `  "pull --check") echo '{"branchStatuses":[],"upToDate":false,"hasWorktreeConflicts":false}' ;;`,
      `  "status -u") echo "Error: The status read failed" >&2; exit 1 ;;`,
      `esac`,
    ].join("\n"),
  );
}

const updateWorkspace = { kind: "updateWorkspace", accepted: null } as const;

/** The log of one workspace update in `directory`: its check, then the pull. */
function updateCalls(directory: string): string[] {
  return [
    `start ${directory} pull --check --json`,
    `end ${directory} pull --check --json`,
    `start ${directory} pull --json`,
    `end ${directory} pull --json`,
  ];
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitbutler-host-"));
  repository = join(scratch, "repo");
  log = join(scratch, "but.log");
  await runGit(scratch, ["init", "--quiet", "--initial-branch=main", repository], signal);
  await runGit(repository, ["config", "user.email", "test@example.com"], signal);
  await runGit(repository, ["config", "user.name", "Test Person"], signal);
  await runGit(repository, ["config", "commit.gpgsign", "false"], signal);
  await writeFile(join(repository, "file.txt"), "base\n");
  await runGit(repository, ["add", "file.txt"], signal);
  await runGit(repository, ["commit", "--quiet", "-m", "chore: the base"], signal);
  // The two parked branches in the branch list fixture, each one commit ahead.
  for (const [branch, subject] of [
    ["scott/monokai-codex-stream", "feat(monokai): stream codex output\n\nThe body."],
    ["release-please--branches--main--components--gh-stack", "chore(main): release gh-stack"],
  ] as const) {
    await runGit(repository, ["switch", "--quiet", "-c", branch, "main"], signal);
    await writeFile(join(repository, "file.txt"), `${branch}\n`);
    await runGit(repository, ["commit", "--quiet", "-am", subject], signal);
  }
  await runGit(repository, ["switch", "--quiet", "main"], signal);
});

afterEach(async () => {
  await restore?.();
  restore = undefined;
  await rm(log, { force: true });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("workspace names the repository it resolved, and leaves the environment to the server", async () => {
  await answering({});
  const workspace = await host.experimental_call("workspace", { environmentPath: repository });

  expect(workspace.state).toBe("ready");
  expect(workspace.repositoryKey).toBe(".");
  expect("environmentId" in workspace).toBe(false);
  expect(workspace.upstream?.latest?.subject).toBe("chore: upstream tip");
});

test("workspace names no repository when there is none", async () => {
  const empty = join(scratch, "empty");
  await mkdir(empty, { recursive: true });
  const workspace = await host.experimental_call("workspace", { environmentPath: empty });

  expect(workspace.state).toBe("noRepository");
  expect(workspace.repositoryKey).toBeNull();
});

test("a base or upstream commit is diffed with git, never asking `but`", async () => {
  await answering({});
  const commitId = (await runGit(repository, ["rev-parse", "main"], signal)).trim();

  for (const where of ["base", "upstream"] as const) {
    const patches = await host.experimental_call("patches", {
      environmentPath: repository,
      source: { kind: "commit", commitId, where },
    });
    expect(patches.files.map((file) => [file.path, file.kind])).toEqual([["file.txt", "added"]]);
  }
  expect(await butCalls()).toEqual([]);
});

test("a workspace commit asks `but diff` first, then falls back to git", async () => {
  await answering({});
  const commitId = (await runGit(repository, ["rev-parse", "main"], signal)).trim();
  const patches = await host.experimental_call("patches", {
    environmentPath: repository,
    source: { kind: "commit", commitId },
  });

  expect(patches.files.map((file) => file.path)).toEqual(["file.txt"]);
  expect(await butCalls()).toEqual([`diff ${commitId} --json`]);
});

test("reviews reads the cached list once, without checks or counts", async () => {
  await answering({ branchList: branchListPayload });
  const answer = await host.experimental_call("reviews", { environmentPath: repository });

  expect(answer).toEqual({
    reviews: [
      {
        branch: "feat/header-polish",
        number: 140,
        state: "open",
        url: "https://github.com/smsunarto/bb-plugins/pull/140",
      },
      {
        branch: "release-please--branches--main--components--gh-stack",
        number: 135,
        state: "open",
        url: "https://github.com/smsunarto/bb-plugins/pull/135",
      },
    ],
    reason: null,
  });
  expect(await butCalls()).toEqual(["branch list --local --review --no-check --no-ahead --json"]);
});

test("parkedBranches fills each branch's subject from git", async () => {
  await answering({ branchList: branchListPayload });
  const answer = await host.experimental_call("parkedBranches", { environmentPath: repository });

  expect(answer).toEqual({
    branches: [
      {
        name: "scott/monokai-codex-stream",
        subject: "feat(monokai): stream codex output",
        updatedAt: "2026-09-30T06:03:46.000Z",
      },
      {
        name: "release-please--branches--main--components--gh-stack",
        subject: "chore(main): release gh-stack",
        updatedAt: "2026-09-15T00:50:31.000Z",
      },
    ],
    hasMore: false,
    reason: null,
  });
  expect(await butCalls()).toEqual(["branch list --local --no-check --no-ahead --json"]);
});

test("a parked branch git cannot find keeps its row with no subject", async () => {
  await answering({
    branchList: { appliedStacks: [], branches: [{ name: "gone", lastCommitAt: 0 }] },
  });
  const answer = await host.experimental_call("parkedBranches", { environmentPath: repository });

  expect(answer).toEqual({
    branches: [{ name: "gone", subject: null, updatedAt: "1970-01-01T00:00:00.000Z" }],
    hasMore: false,
    reason: null,
  });
});

test("oplog reads the operations and never restores or undoes", async () => {
  await answering({ oplog: oplogPayload });
  const answer = await host.experimental_call("oplog", { environmentPath: repository });

  expect(answer.reason).toBeNull();
  expect(answer.entries.map((entry) => entry.operation)).toEqual([
    "SquashCommit",
    "CreateCommit",
    "MergeUpstream",
  ]);
  expect(await butCalls()).toEqual(["oplog list --json"]);
});

test("each read explains a failing `but` instead of throwing", async () => {
  restore = await fakeBut(`echo "Error: The repository is not set up for GitButler" >&2; exit 1`);

  for (const [method, empty] of [
    ["reviews", { reviews: [] }],
    ["oplog", { entries: [] }],
    ["parkedBranches", { branches: [], hasMore: false }],
  ] as const) {
    const answer = await host.experimental_call(method, { environmentPath: repository });
    expect(answer).toEqual({
      ...empty,
      reason: "Error: The repository is not set up for GitButler",
    } as never);
  }
});

test("two actions on one repository run one after the other, checks included", async () => {
  await slowActions();
  // The same repository spelled through a symlink still waits its turn.
  const alias = join(scratch, "alias");
  await symlink(repository, alias);
  const answers = await Promise.all(
    [repository, alias].map((environmentPath) =>
      host.experimental_call("butAction", { environmentPath, action: updateWorkspace }),
    ),
  );

  expect(answers).toEqual([{ status: "done" }, { status: "done" }]);
  expect(await butCalls()).toEqual([...updateCalls("repo"), ...updateCalls("repo")]);
});

test("actions on different repositories run at the same time", async () => {
  await slowActions();
  const other = join(scratch, "other");
  await runGit(scratch, ["init", "--quiet", other], signal);
  await Promise.all(
    [repository, other].map((environmentPath) =>
      host.experimental_call("butAction", { environmentPath, action: updateWorkspace }),
    ),
  );

  // Both checks started before either one ended.
  expect((await butCalls()).slice(0, 2).sort()).toEqual([
    "start other pull --check --json",
    "start repo pull --check --json",
  ]);
});

test("a failed action frees the repository for the next one", async () => {
  await slowActions();
  const failing = host.experimental_call("butAction", {
    environmentPath: repository,
    action: { kind: "delete", branch: "gone", accepted: null },
  });
  // The next action arrives while the first is still reading the status.
  while (!(await butCalls()).includes("start repo status -u --json")) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const next = host.experimental_call("butAction", {
    environmentPath: repository,
    action: updateWorkspace,
  });

  await expect(failing).rejects.toThrow("Error: The status read failed");
  expect(await next).toEqual({ status: "done" });
  expect(await butCalls()).toEqual([
    "start repo status -u --json",
    "end repo status -u --json",
    ...updateCalls("repo"),
  ]);
});
