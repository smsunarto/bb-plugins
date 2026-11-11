/**
 * The plain-git workspace provider's writes: push, pull (rebase onto the
 * target), and land (publish one commit onto the target). Ported from
 * `plugins/gitbutler/src/host/git-actions.ts`; rename and delete stay there.
 * A write that finds a risk the reader did not accept returns `confirm` and
 * changes nothing; a refusal throws.
 */
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { VcsAction, VcsResult } from "../core/change.ts";
import { readCheckout, unchanged, type Checkout } from "./checkout.ts";
import { CommandFailedError, runBut, runGit, runGitCommand } from "./cli.ts";
import { countCommits, readGitDetails, readGitStatus, type GitDetails } from "./git-workspace.ts";
import { parseWorkspace } from "./parse.ts";

const DONE: VcsResult = { status: "done" };
const UP_TO_DATE: VcsResult = { status: "upToDate" };

async function idle(cwd: string, signal: AbortSignal) {
  const operations = await Promise.allSettled(
    ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].map(
      async (marker) => {
        const path = (await runGit(cwd, ["rev-parse", "--git-path", marker], signal)).trim();
        return access(resolve(cwd, path)).then(
          () => true,
          () => false,
        );
      },
    ),
  );
  for (const operation of operations) {
    if (operation.status === "rejected") throw operation.reason;
  }
  if (operations.some((operation) => operation.status === "fulfilled" && operation.value)) {
    throw new CommandFailedError(
      "Finish or abort the checkout's current merge, rebase, or cherry-pick before running another action.",
    );
  }
}

async function clean(cwd: string, signal: AbortSignal) {
  if ((await readGitStatus(cwd, signal)).changes.length) {
    throw new CommandFailedError(
      "Commit or move the checkout's uncommitted changes before this action. No files were changed.",
    );
  }
}

const metadataBranches = z.object({
  branches: z.record(
    z.string(),
    z
      .object({
        name: z.string().optional(),
        heads: z.array(z.object({ name: z.string() })).optional(),
      })
      .refine((stack) => stack.name !== undefined || (stack.heads?.length ?? 0) > 0),
  ),
});

/** Parked and archived heads still own shared refs outside workspace mode. */
async function notRecorded(cwd: string, gitDir: string, branch: string, signal: AbortSignal) {
  const customStorage = await runGitCommand(
    cwd,
    ["--git-dir", gitDir, "config", "--get-regexp", "^gitbutler(\\.(nightly|dev))?\\.storagepath$"],
    signal,
  );
  if (customStorage.code !== 0 && customStorage.code !== 1)
    throw new CommandFailedError(
      "GitButler storage configuration could not be checked. No action was run.",
    );
  if (customStorage.code === 0)
    throw new CommandFailedError(
      "This repository uses a custom GitButler storage path. Run this action in GitButler, where its branch metadata can be checked safely.",
    );
  const storage = resolve(gitDir, "gitbutler");
  let content: string;
  try {
    content = await readFile(resolve(storage, "virtual_branches.toml"), "utf8");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !(await access(storage).then(
        () => true,
        () => false,
      ))
    )
      return;
    throw new CommandFailedError(
      "GitButler branch metadata could not be read. Open the main GitButler workspace to repair or refresh it before running this action.",
    );
  }
  let metadata: z.infer<typeof metadataBranches>;
  try {
    metadata = metadataBranches.parse(parseToml(content));
  } catch {
    throw new CommandFailedError(
      "GitButler branch metadata is invalid. Open the main GitButler workspace to repair or refresh it before running this action.",
    );
  }
  if (
    Object.values(metadata.branches).some(
      (stack) => stack.name === branch || stack.heads?.some((head) => head.name === branch),
    )
  )
    throw new CommandFailedError(
      "This branch is recorded in GitButler metadata. Run its actions in the main GitButler workspace before changing its shared ref from this checkout.",
    );
}

/** Shared refs can also belong to an applied lane in the main GitButler workspace. */
async function notApplied(checkout: Checkout, branch: string, signal: AbortSignal) {
  const cwd = checkout.path;
  const { commonDir } = checkout;
  const registered = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"], signal);
  const directory = resolve(commonDir, "worktrees");
  const linked = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CommandFailedError(
      "Git's worktree administration could not be read. Restore access so GitButler branch metadata can be checked before running this action.",
    );
  });
  // Deleted worktree paths can leave metadata in their Git-owned administrative directory.
  const gitDirs = [
    commonDir,
    ...linked
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => resolve(directory, entry.name)),
  ];
  const inspected = await Promise.allSettled([
    ...gitDirs.map((gitDir) => notRecorded(cwd, gitDir, branch, signal)),
    ...registered.split("\0\0").map(async (record, index) => {
      const fields = record.split("\0");
      const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
      if (!path) return;
      // Git lists the main worktree first. Its metadata remains authoritative if unavailable.
      const required = index === 0 || resolve(path) === cwd;
      if (
        !required &&
        fields.some((field) => field === "prunable" || field.startsWith("prunable "))
      )
        return;
      const present = await stat(path).then(
        (entry) => entry.isDirectory(),
        (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return false;
          throw new CommandFailedError(
            "A registered checkout is inaccessible. Restore its permissions so GitButler branch metadata can be checked before running this action.",
          );
        },
      );
      if (!present) {
        if (required)
          throw new CommandFailedError(
            "The main or selected checkout is unavailable. Restore its path so GitButler branch metadata can be checked before running this action.",
          );
        return;
      }
      const real = await realpath(path).catch(() => path);
      if (fields.includes(`branch refs/heads/${branch}`) && real !== cwd) {
        throw new CommandFailedError(
          "This branch is also checked out in another worktree. Leave that checkout before changing its shared ref here.",
        );
      }
      if (real === cwd || !fields.some((field) => field.startsWith("branch refs/heads/gitbutler/")))
        return;
      if (!(await readCheckout(path, signal))?.gitbutler) return;
      const workspace = parseWorkspace(await runBut(path, ["status"], signal));
      if (workspace.stacks.some((stack) => stack.branches.some((entry) => entry.name === branch))) {
        throw new CommandFailedError(
          "This branch is applied in the main GitButler workspace. Run its actions there before changing its shared ref from this checkout.",
        );
      }
    }),
  ]);
  for (const result of inspected) {
    if (result.status === "rejected") throw result.reason;
  }
}

async function fetchRemote(cwd: string, remote: string, signal: AbortSignal) {
  await runGit(cwd, ["fetch", "--prune", "--", remote], signal);
}

async function remoteTip(
  cwd: string,
  remote: string,
  ref: string,
  signal: AbortSignal,
): Promise<string | null> {
  const output = await runGit(cwd, ["ls-remote", "--refs", "--", remote, ref], signal);
  return (
    output
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, name]) => name === ref)?.[0] ?? null
  );
}

/** A transmission failure can happen after the server accepted the ref update. */
async function publish(
  cwd: string,
  remote: string,
  ref: string,
  head: string,
  expected: string | null,
  signal: AbortSignal,
) {
  try {
    await runGit(
      cwd,
      [
        "push",
        "--porcelain",
        `--force-with-lease=${ref}:${expected ?? ""}`,
        "--",
        remote,
        `${head}:${ref}`,
      ],
      signal,
    );
  } catch (error) {
    let current: string | null;
    try {
      current = await remoteTip(cwd, remote, ref, signal);
    } catch {
      throw new CommandFailedError(
        `Publication status is unknown after the push failed. Check ${ref} on ${remote} before retrying. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (current === head) return;
    if (current !== expected) {
      throw new CommandFailedError(
        `Publication status is unknown: ${ref} now names another commit. Check the remote and refresh before retrying. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new CommandFailedError(
      `The push did not leave ${ref} at the requested commit. Refresh before retrying. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function push(
  action: Extract<VcsAction, { kind: "push" }>,
  before: Checkout,
  signal: AbortSignal,
): Promise<VcsResult> {
  const cwd = before.path;
  let details = await readGitDetails(before, signal);
  const remote = details.pushRemote;
  if (!remote || !before.head || !before.branch)
    throw new CommandFailedError("This branch has no commit or configured push remote.");
  if (details.configuredTracking && details.configuredTracking.remote !== remote) {
    throw new CommandFailedError(
      "The push remote differs from this branch's upstream. Choose a matching upstream before pushing here.",
    );
  }
  await fetchRemote(cwd, remote, signal);
  await unchanged(before, signal);
  details = await readGitDetails(before, signal);
  const destination = details.configuredTracking?.name ?? details.tracking?.name ?? before.branch;
  const ref = `refs/heads/${destination}`;
  const expected = await remoteTip(cwd, remote, ref, signal);
  if (expected === before.head) return UP_TO_DATE;
  if (expected) {
    const ancestor = await runGitCommand(
      cwd,
      ["merge-base", "--is-ancestor", expected, before.head],
      signal,
    );
    if (ancestor.code !== 0 && ancestor.code !== 1)
      throw new CommandFailedError(
        ancestor.stderr.trim() || "The remote branch could not be compared.",
      );
    if (ancestor.code === 1 && !action.force)
      throw new CommandFailedError(
        "The remote branch diverged. Refresh and confirm a force push before replacing it.",
      );
    const loss = (
      await runGit(
        cwd,
        ["rev-list", "--right-only", "--cherry-pick", `${before.head}...${expected}`],
        signal,
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const agreed = new Set(action.acceptedLoss);
    if (loss.some((commit) => !agreed.has(commit))) return { status: "confirm", risk: null, loss };
  }
  await unchanged(before, signal);
  await publish(cwd, remote, ref, before.head, expected, signal);
  // Git updates a configured remote-tracking ref on push. Configure the first
  // upstream only after publication, never replacing an existing upstream.
  const configured = await runGit(
    cwd,
    ["for-each-ref", "--format=%(refname)%00%(upstream)", `refs/heads/${before.branch}`],
    signal,
  );
  if (configured.split("\n").some((line) => line === `refs/heads/${before.branch}\0`)) {
    await runGit(
      cwd,
      ["branch", `--set-upstream-to=${remote}/${destination}`, before.branch],
      signal,
    ).catch((error: unknown) => {
      throw new CommandFailedError(
        `Published ${before.branch}, but its upstream could not be configured. ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  return DONE;
}

/** Brings the branch up to its target by rebasing it onto the target's newest commit. */
async function rebase(
  action: Extract<VcsAction, { kind: "pull" }>,
  before: Checkout,
  signal: AbortSignal,
): Promise<VcsResult> {
  const cwd = before.path;
  await clean(cwd, signal);
  const prior = await readGitDetails(before, signal);
  if (!prior.target)
    throw new CommandFailedError("The checkout has no remote default branch to pull.");
  await fetchRemote(cwd, prior.target.remote, signal);
  await unchanged(before, signal);
  const destination = (await readGitDetails(before, signal)).target;
  if (!destination || !before.head)
    throw new CommandFailedError("The branch or its target no longer exists.");
  const count = await countCommits(cwd, `${before.head}..${destination.head}`, signal);
  if (count === 0) return UP_TO_DATE;
  // A merge preview does not predict every intermediate replay conflict, so
  // ask about the branch before a divergent rebase can leave a stopped replay.
  const ancestor = await runGitCommand(
    cwd,
    ["merge-base", "--is-ancestor", before.head, destination.head],
    signal,
  );
  if (ancestor.code !== 0 && ancestor.code !== 1)
    throw new CommandFailedError(ancestor.stderr.trim() || "The target could not be compared.");
  if (ancestor.code === 1 && !action.accepted?.conflicted.includes(before.branch!)) {
    return {
      status: "confirm",
      risk: { conflicted: [before.branch!], overlapsUncommitted: false },
      loss: null,
    };
  }
  await unchanged(before, signal);
  await runGit(cwd, ["rebase", "--no-autostash", destination.head], signal);
  return DONE;
}

/** Detaches the checkout at `destination` and deletes the landed branch. */
async function remove(before: Checkout, destination: string, signal: AbortSignal) {
  const cwd = before.path;
  await unchanged(before, signal);
  await clean(cwd, signal);
  await runGit(cwd, ["switch", "--detach", destination], signal);
  try {
    await runGit(cwd, ["update-ref", "-d", `refs/heads/${before.branch}`, before.head!], signal);
  } catch (error) {
    const current = await readCheckout(cwd, signal);
    let restored = false;
    if (current?.branch === null && current.head === destination) {
      const ref = await runGit(
        cwd,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${before.branch}`],
        signal,
      ).catch(() => "");
      if (ref.trim() === before.head)
        restored = await runGit(cwd, ["switch", before.branch!], signal).then(
          () => true,
          () => false,
        );
    }
    throw new CommandFailedError(
      `The branch could not be deleted. ${restored ? "The original branch was reattached." : "The checkout remains detached."} No worktree was removed. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const removed = await runGitCommand(
    cwd,
    ["config", "--local", "--remove-section", `branch.${before.branch}`],
    signal,
  );
  if (removed.code !== 0) {
    const escaped = before.branch!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remaining = await runGitCommand(
      cwd,
      ["config", "--local", "--get-regexp", `^branch\\.${escaped}\\.`],
      signal,
    );
    if (remaining.code !== 1)
      throw new CommandFailedError(
        "The branch was deleted, but its local branch configuration could not be removed. The checkout remains detached and its files were preserved. Remove the stale branch configuration before recreating this branch.",
      );
  }
}

/** A single contribution retains its authorship; a squash uses the committer's identity. */
async function landingCommit(
  cwd: string,
  source: { head: string; parent: string; tree: string; message: string; single: boolean },
  signal: AbortSignal,
): Promise<string> {
  const original = source.single
    ? (
        await runGit(
          cwd,
          ["show", "-s", "--format=%P%x00%an%x00%ae%x00%aI", source.head, "--"],
          signal,
        )
      )
        .trimEnd()
        .split("\0")
    : null;
  if (original && original.length !== 4)
    throw new CommandFailedError(
      "The original commit's author could not be read. Land stopped before publication.",
    );
  // Reusing the original object also retains its message, signature, and identity.
  if (original?.[0] === source.parent) return source.head;
  const signing = await runGit(cwd, ["config", "--bool", "--get", "commit.gpgsign"], signal).catch(
    () => "false",
  );
  return (
    await runGit(
      cwd,
      [
        "commit-tree",
        ...(signing.trim() === "true" ? ["-S"] : []),
        source.tree,
        "-p",
        source.parent,
        "-m",
        source.message,
      ],
      signal,
      original
        ? {
            env: {
              GIT_AUTHOR_NAME: original[1],
              GIT_AUTHOR_EMAIL: original[2],
              GIT_AUTHOR_DATE: original[3],
            },
          }
        : {},
    )
  ).trim();
}

/** The branch's own commits since its target, and its newest commit's whole message. */
async function ownCommits(details: GitDetails, signal: AbortSignal) {
  const { checkout, base } = details;
  const head = checkout.head!;
  const [count, message] = await Promise.all([
    countCommits(checkout.path, base ? `${base}..${head}` : head, signal),
    runGit(checkout.path, ["show", "-s", "--format=%B", head, "--"], signal),
  ]);
  return { count, message: message.trimEnd() };
}

async function land(
  action: Extract<VcsAction, { kind: "land" }>,
  before: Checkout,
  signal: AbortSignal,
): Promise<VcsResult> {
  const cwd = before.path;
  await clean(cwd, signal);
  const initial = await readGitDetails(before, signal);
  if (!initial.target)
    throw new CommandFailedError("The checkout has no remote default branch to land on.");
  await fetchRemote(cwd, initial.target.remote, signal);
  await unchanged(before, signal);
  const details = await readGitDetails(before, signal);
  const target = details.target;
  if (!target || !before.head || !before.branch)
    throw new CommandFailedError("The branch or landing target no longer exists.");
  if (target.name === before.branch)
    throw new CommandFailedError("The checked-out branch is already the landing target.");
  const own = await ownCommits(details, signal);
  if (own.count === 0) return UP_TO_DATE;
  if (own.count > 1 !== (action.message !== null))
    throw new CommandFailedError(
      "The branch's commits changed. Refresh and choose Land again to confirm its commit message.",
    );
  const message = action.message ?? own.message;
  const merge = await runGitCommand(
    cwd,
    ["merge-tree", "--write-tree", target.head, before.head],
    signal,
  );
  if (merge.code === 1)
    throw new CommandFailedError(
      "Land stopped before publication: the branch conflicts with its target. Pull the target and resolve the conflicts first.",
    );
  if (merge.code !== 0)
    throw new CommandFailedError(
      `The landing tree could not be prepared. Land requires Git 2.38 or newer. ${merge.stderr.trim()}`,
    );
  const tree = merge.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new CommandFailedError("Git returned an invalid landing tree.");
  const targetTree = (await runGit(cwd, ["rev-parse", `${target.head}^{tree}`], signal)).trim();
  if (tree === targetTree) return UP_TO_DATE;
  const commit = await landingCommit(
    cwd,
    { head: before.head, parent: target.head, tree, message, single: own.count === 1 },
    signal,
  );
  await unchanged(before, signal);
  await clean(cwd, signal);
  await publish(cwd, target.remote, `refs/heads/${target.name}`, commit, target.head, signal);
  try {
    await remove(before, commit, signal);
  } catch (error) {
    throw new CommandFailedError(
      `Published the landing commit to ${target.remote}/${target.name}, but local cleanup stopped. Refresh before another action. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return DONE;
}

/** Runs one write in the plain checkout at `cwd`. Callers serialize writes per Git directory. */
export async function runGitWrite(
  cwd: string,
  action: VcsAction,
  signal: AbortSignal,
): Promise<VcsResult> {
  const before = await readCheckout(cwd, signal);
  if (!before?.branch)
    throw new CommandFailedError("Check out a named branch before running this action.");
  if (before.gitbutler)
    throw new CommandFailedError(
      "This checkout is a GitButler workspace. Read it as GitButler to change it.",
    );
  if (action.kind !== "pull" && action.branch !== before.branch)
    throw new CommandFailedError(`${action.branch} is no longer checked out here.`);
  await idle(before.path, signal);
  await notApplied(before, before.branch, signal);
  switch (action.kind) {
    case "push":
      return push(action, before, signal);
    case "pull":
      return rebase(action, before, signal);
    case "land":
      return land(action, before, signal);
    case "delete": {
      if (!before.head)
        throw new CommandFailedError("An unborn branch has no commit to preserve before deletion.");
      // Plain git deletes the checked-out branch: the checkout is left detached at its head.
      await remove(before, before.head, signal);
      return DONE;
    }
    case "commit":
      return commit(action, before.path, signal);
  }
}

/**
 * Commits exactly the reader's paths, whatever else is staged: they are
 * staged (new, changed or deleted) and committed alone. Pathspecs are
 * literal, so a file named `*.ts` is that file.
 */
async function commit(
  action: Extract<VcsAction, { kind: "commit" }>,
  cwd: string,
  signal: AbortSignal,
): Promise<VcsResult> {
  await runGit(cwd, ["--literal-pathspecs", "add", "--all", "--", ...action.paths], signal);
  await runGit(
    cwd,
    [
      "--literal-pathspecs",
      "commit",
      "--quiet",
      "--message",
      action.message,
      "--",
      ...action.paths,
    ],
    signal,
  );
  return DONE;
}
