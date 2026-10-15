import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

/** A repository at `path` whose HEAD is on `head`, with `origin` as its only remote. */
async function checkout(path: string, head: string, origin: string) {
  await runGit(scratch, ["init", "--quiet", `--initial-branch=${head}`, path], signal);
  await runGit(path, ["remote", "add", "origin", origin], signal);
}

test("checkouts keeps GitButler workspaces and named clones of one origin, each once", async () => {
  await answering({});
  const machine = join(scratch, "machine");
  await checkout(join(machine, "app"), "gitbutler/workspace", "git@github.com:o/app.git");
  // The same repository over HTTPS, as an environment's repos/ child.
  await checkout(
    join(machine, "env", "repos", "app"),
    "gitbutler/workspace",
    "https://github.com/O/app",
  );
  // An unborn plain clone still has a named branch, without an invented commit.
  await checkout(join(machine, "clone"), "main", "git@github.com:o/app.git");
  await checkout(join(machine, "other"), "gitbutler/workspace", "git@github.com:o/other.git");
  await symlink(join(machine, "app"), join(machine, "alias"));

  const answer = await host.experimental_call("checkouts", {
    paths: ["app", "alias", "env", "clone", "other", "gone"].map((name) => join(machine, name)),
    origin: "github.com/o/app",
  });

  const real = await realpath(machine);
  expect(
    answer.checkouts.map(({ path, state, stacks, gitBranch }) => ({
      path,
      state,
      branches: gitBranch
        ? [gitBranch.name]
        : stacks.flatMap((stack) => stack.branches.map((branch) => branch.name)),
    })),
  ).toEqual([
    {
      path: join(real, "app"),
      state: "ready",
      branches: ["scott/top", "scott/bottom", "scott/experimental"],
    },
    {
      path: join(real, "clone"),
      state: "ready",
      branches: ["main"],
    },
    {
      path: join(real, "env", "repos", "app"),
      state: "ready",
      branches: ["scott/top", "scott/bottom", "scott/experimental"],
    },
  ]);
  expect(answer.checkouts.find(({ path }) => path === join(real, "clone"))).toEqual({
    path: join(real, "clone"),
    state: "ready",
    reason: null,
    stacks: [],
    gitBranch: { name: "main", head: null },
  });
  // The clone, the other repository, and the missing path never reach `but`.
  expect(await butCalls()).toEqual(["status -u --json", "status -u --json"]);
});

test("an unregistered linked checkout shows its actual branch and commit without running but there", async () => {
  await answering({});
  const main = join(scratch, "linked-machine", "main");
  await checkout(main, "gitbutler/workspace", "git@github.com:Acme/App.git");
  await runGit(main, ["config", "user.email", "test@example.com"], signal);
  await runGit(main, ["config", "user.name", "Test Person"], signal);
  await runGit(main, ["config", "commit.gpgsign", "false"], signal);
  await runGit(main, ["commit", "--quiet", "--allow-empty", "-m", "chore: base"], signal);
  const isolated = join(scratch, "isolated-checkouts", "performance");
  await runGit(main, ["worktree", "add", "--quiet", "-b", "scott/performance", isolated], signal);
  await runGit(
    isolated,
    ["commit", "--quiet", "--allow-empty", "-m", "perf: measure connection\n\nPreserve this body."],
    signal,
  );
  const head = (await runGit(isolated, ["rev-parse", "HEAD"], signal)).trim();
  const answer = await host.experimental_call("checkouts", {
    paths: [main],
    origin: "github.com/acme/app",
  });
  expect(answer.checkouts.find(({ path }) => path === isolated)).toEqual({
    path: isolated,
    state: "ready",
    reason: null,
    stacks: [],
    gitBranch: {
      name: "scott/performance",
      head: {
        commitId: head,
        message: "perf: measure connection\n\nPreserve this body.",
        authorName: "Test Person",
        createdAt: (await runGit(isolated, ["show", "-s", "--format=%aI", "HEAD"], signal)).trim(),
      },
    },
  });
  expect(answer.checkouts.find(({ path }) => path === main)?.stacks).toHaveLength(2);
  expect(await butCalls()).toEqual(["status -u --json"]);

  // A broken GitButler workspace leaves the healthy Git-only checkout visible.
  await restore?.();
  restore = await fakeBut(`echo "Error: Broken workspace" >&2; exit 1`);
  const partial = await host.experimental_call("checkouts", {
    paths: [main],
    origin: "github.com/acme/app",
  });
  expect(partial.checkouts.find(({ path }) => path === main)).toEqual({
    path: main,
    state: "error",
    reason: "Error: Broken workspace",
    stacks: [],
  });
  expect(partial.checkouts.find(({ path }) => path === isolated)?.gitBranch?.head?.message).toBe(
    "perf: measure connection\n\nPreserve this body.",
  );
});

/**
 * A GitButler workspace with a two-branch stack on `main`: `scott/bottom`
 * adds `bottom.txt`, `scott/top` adds `top.txt` above it. Answers with the
 * commit ids of `main`, bottom, and top.
 */
async function stackedWorkspace(path: string) {
  await checkout(path, "main", "git@github.com:Acme/App.git");
  await runGit(path, ["config", "user.email", "test@example.com"], signal);
  await runGit(path, ["config", "user.name", "Test Person"], signal);
  await runGit(path, ["config", "commit.gpgsign", "false"], signal);
  const commit = async (file: string, message: string) => {
    await writeFile(join(path, file), `${file}\n`);
    await runGit(path, ["add", file], signal);
    await runGit(path, ["commit", "--quiet", "-m", message], signal);
    return (await runGit(path, ["rev-parse", "HEAD"], signal)).trim();
  };
  const base = await commit("base.txt", "chore: base");
  const bottom = await commit("bottom.txt", "feat: bottom");
  const top = await commit("top.txt", "feat: top");
  await runGit(path, ["switch", "--quiet", "-c", "gitbutler/workspace"], signal);
  return { base, bottom, top };
}

/** A `but status` stack branch for `parseWorkspace`. */
function rawBranch(name: string, commitIds: string[], extra: Record<string, unknown> = {}) {
  return {
    cliId: name.slice(0, 2),
    name,
    commits: commitIds.map((commitId) => ({
      cliId: commitId.slice(0, 3),
      changeId: null,
      commitId,
      createdAt: "2026-09-22T21:43:26+00:00",
      message: `commit ${commitId.slice(0, 7)}`,
      authorName: "Test Person",
      authorEmail: "test@example.com",
      conflicted: false,
      reviewId: null,
      changes: null,
    })),
    upstreamCommits: [],
    branchStatus: "completelyUnpushed",
    reviewId: null,
    ci: null,
    ...extra,
  };
}

test("unpublishedBranches names each workspace branch with no review yet, and where it starts", async () => {
  const machine = join(scratch, "unpublished");
  const { base, bottom, top } = await stackedWorkspace(join(machine, "app"));
  // A plain clone is not a workspace, and never reaches `but`.
  await checkout(join(machine, "clone"), "main", "git@github.com:acme/app.git");
  const payload = join(scratch, "unpublished-status.json");
  await writeFile(
    payload,
    JSON.stringify({
      ...statusPayload,
      stacks: [
        {
          cliId: "s1",
          assignedChanges: [],
          branches: [rawBranch("scott/top", [top]), rawBranch("scott/bottom", [bottom])],
        },
        {
          cliId: "s2",
          assignedChanges: [],
          branches: [
            rawBranch("scott/in-review", [bottom], {
              reviewId: "(#7)",
              branchStatus: "nothingToPush",
            }),
            rawBranch("scott/landed", [base], { branchStatus: "integrated" }),
            rawBranch("scott/empty", []),
          ],
        },
      ],
    }),
  );
  restore = await fakeBut(
    [
      `printf '%s\n' "$*" >> '${log}'`,
      `case "$1 $2" in`,
      `  "status --json") cat '${payload}' ;;`,
      `  *) echo "unexpected" >&2; exit 1 ;;`,
      `esac`,
    ].join("\n"),
  );

  const answer = await host.experimental_call("unpublishedBranches", {
    paths: [join(machine, "app"), join(machine, "clone")],
  });

  const real = await realpath(join(machine, "app"));
  expect(
    answer.branches.map(({ commits, ...branch }) =>
      Object.assign(branch, { commits: commits.map((c) => c.commitId) }),
    ),
  ).toEqual([
    {
      path: real,
      repoName: "app",
      origin: "github.com/acme/app",
      branch: "scott/top",
      status: "unpushed",
      head: top,
      base: bottom,
      parent: "scott/bottom",
      commits: [top],
    },
    {
      path: real,
      repoName: "app",
      origin: "github.com/acme/app",
      branch: "scott/bottom",
      status: "unpushed",
      head: bottom,
      base,
      parent: null,
      commits: [bottom],
    },
  ]);
  expect(await butCalls()).toEqual(["status --json"]);
});

test("a range patch is everything the head changes since the base, from git", async () => {
  const app = join(scratch, "range", "app");
  const { base, top } = await stackedWorkspace(app);
  const patches = await host.experimental_call("patches", {
    environmentPath: app,
    source: { kind: "range", base, head: top, within: [join(scratch, "elsewhere"), app] },
  });

  expect(patches.files.map((file) => [file.path, file.kind])).toEqual([
    ["bottom.txt", "added"],
    ["top.txt", "added"],
  ]);
  expect(patches.files[1]?.patch).toContain("+top.txt");
});

test("a range is read only in a GitButler workspace among the checkouts bb knows", async () => {
  const app = join(scratch, "range-known", "app");
  const { base, top } = await stackedWorkspace(app);
  const range = { kind: "range", base, head: top } as const;

  await expect(
    host.experimental_call("patches", {
      environmentPath: app,
      source: { ...range, within: [repository] },
    }),
  ).rejects.toThrow("That is not a GitButler workspace bb knows on this machine.");
  // A plain clone bb knows is still not a workspace.
  await expect(
    host.experimental_call("patches", {
      environmentPath: repository,
      source: { ...range, within: [repository] },
    }),
  ).rejects.toThrow("That is not a GitButler workspace bb knows on this machine.");
});

test("origin names the resolved repository and its normalized remote", async () => {
  const answer = await host.experimental_call("origin", { environmentPath: repository });
  expect(answer).toEqual({ path: await realpath(repository), origin: null });

  const remote = join(scratch, "remote-origin");
  await checkout(remote, "main", "git@github.com:Smsunarto/BB-Plugins.git");
  expect(await host.experimental_call("origin", { environmentPath: remote })).toEqual({
    path: await realpath(remote),
    origin: "github.com/smsunarto/bb-plugins",
  });
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
