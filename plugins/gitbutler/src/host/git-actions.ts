import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { ButAction, ButActionResult } from "../shared/schema.ts";
import { ButFailedError, runBut, runGit, runGitCommand } from "./cli.ts";
import {
  isGitButlerHead,
  readGitCheckout,
  readGitStatus,
  readGitWorkspaceDetails,
} from "./git-workspace.ts";
import type { GitCheckoutIdentity, GitWorkspaceDetails } from "./git-workspace.ts";
import { parseWorkspace } from "./parse.ts";

export type ObservedCheckout = {
  branch: string | null;
  head: string | null;
  origin: string | null;
};
const DONE: ButActionResult = { status: "done" };
const UP_TO_DATE: ButActionResult = { status: "upToDate" };

function changed(): never {
  throw new ButFailedError(
    "The checkout's branch, HEAD, or origin changed. Refresh the board before trying again.",
  );
}

async function unchanged(cwd: string, before: GitCheckoutIdentity, signal: AbortSignal) {
  const now = await readGitCheckout(cwd, signal);
  if (
    now.branch !== before.branch ||
    now.head !== before.head ||
    now.origin !== before.origin ||
    now.commonDir !== before.commonDir
  )
    changed();
}

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
    throw new ButFailedError(
      "Finish or abort the checkout's current merge, rebase, or cherry-pick before running another action.",
    );
  }
}

async function clean(cwd: string, signal: AbortSignal) {
  if ((await readGitStatus(cwd, signal)).changes.length) {
    throw new ButFailedError(
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

/** Parked and archived heads still own shared refs even outside workspace mode. */
async function notRecorded(cwd: string, gitDir: string, branch: string, signal: AbortSignal) {
  const customStorage = await runGitCommand(
    cwd,
    ["--git-dir", gitDir, "config", "--get-regexp", "^gitbutler(\\.(nightly|dev))?\\.storagepath$"],
    signal,
  );
  if (customStorage.code !== 0 && customStorage.code !== 1)
    throw new ButFailedError(
      "GitButler storage configuration could not be checked. No action was run.",
    );
  if (customStorage.code === 0)
    throw new ButFailedError(
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
    throw new ButFailedError(
      "GitButler branch metadata could not be read. Open the main GitButler workspace to repair or refresh it before running this action.",
    );
  }
  let metadata: z.infer<typeof metadataBranches>;
  try {
    metadata = metadataBranches.parse(parseToml(content));
  } catch {
    throw new ButFailedError(
      "GitButler branch metadata is invalid. Open the main GitButler workspace to repair or refresh it before running this action.",
    );
  }
  if (
    Object.values(metadata.branches).some(
      (stack) => stack.name === branch || stack.heads?.some((head) => head.name === branch),
    )
  )
    throw new ButFailedError(
      "This branch is recorded in GitButler metadata. Run its actions in the main GitButler workspace before changing its shared ref from an isolated checkout.",
    );
}

/** Shared refs can also belong to an applied lane in the main But workspace. */
async function notApplied(cwd: string, branch: string, signal: AbortSignal) {
  const [registered, checkoutPath, common] = await Promise.all([
    runGit(cwd, ["worktree", "list", "--porcelain", "-z"], signal),
    realpath(cwd),
    runGit(cwd, ["rev-parse", "--git-common-dir"], signal),
  ]);
  const commonDir = await realpath(resolve(checkoutPath, common.trim()));
  const directory = resolve(commonDir, "worktrees");
  const linked = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ButFailedError(
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
      const required = index === 0 || resolve(path) === checkoutPath;
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
          throw new ButFailedError(
            "A registered checkout is inaccessible. Restore its permissions so GitButler branch metadata can be checked before running this action.",
          );
        },
      );
      if (!present) {
        if (required)
          throw new ButFailedError(
            "The main or selected checkout is unavailable. Restore its path so GitButler branch metadata can be checked before running this action.",
          );
        return;
      }
      if (
        fields.includes(`branch refs/heads/${branch}`) &&
        (await realpath(path).catch(() => path)) !== checkoutPath
      ) {
        throw new ButFailedError(
          "This branch is also checked out in another worktree. Leave that checkout before changing its shared ref here.",
        );
      }
      if (
        !fields.some((field) => field.startsWith("branch ") && isGitButlerHead(field.slice(7))) ||
        (await readGitCheckout(path, signal)).kind !== "gitbutler"
      )
        return;
      const workspace = parseWorkspace(await runBut(path, ["status"], signal));
      if (workspace.stacks.some((stack) => stack.branches.some((entry) => entry.name === branch))) {
        throw new ButFailedError(
          "This branch is applied in the main GitButler workspace. Run its actions there before changing its shared ref from an isolated checkout.",
        );
      }
    }),
  ]);
  for (const result of inspected) {
    if (result.status === "rejected") throw result.reason;
  }
}

/** Child agents mutate this same checkout; they must pass the shared-ref guard. */
export async function prepareGitCheckoutChild(
  cwd: string,
  kind: "review" | "conflicts",
  observed: ObservedCheckout,
  signal: AbortSignal,
): Promise<GitCheckoutIdentity> {
  const identity = await readGitCheckout(cwd, signal);
  if (
    identity.kind !== "git" ||
    identity.branch !== observed.branch ||
    identity.head !== observed.head ||
    identity.origin !== observed.origin
  )
    changed();
  if (kind === "review") {
    if (!identity.branch)
      throw new ButFailedError("Choose a named branch before creating its review.");
    await idle(cwd, signal);
  }
  let branch = identity.branch;
  if (kind === "conflicts" && branch === null) {
    for (const marker of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
      const path = (await runGit(cwd, ["rev-parse", "--git-path", marker], signal)).trim();
      const ref = await readFile(resolve(cwd, path), "utf8").catch(() => "");
      if (ref.trim().startsWith("refs/heads/")) {
        branch = ref.trim().slice(11);
        break;
      }
    }
  }
  if (branch) await notApplied(cwd, branch, signal);
  await unchanged(cwd, identity, signal);
  return identity;
}

async function fetchRemote(cwd: string, remote: string, signal: AbortSignal) {
  await runGit(cwd, ["fetch", "--prune", "--", remote], signal);
}

async function state(cwd: string, signal: AbortSignal): Promise<GitWorkspaceDetails> {
  return readGitWorkspaceDetails({ path: cwd, key: ".", name: basename(cwd) }, signal);
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
      throw new ButFailedError(
        `Publication status is unknown after the push failed. Check ${ref} on ${remote} before retrying. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (current === head) return;
    if (current !== expected) {
      throw new ButFailedError(
        `Publication status is unknown: ${ref} now names another commit. Check the remote and refresh before retrying. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new ButFailedError(
      `The push did not leave ${ref} at the requested commit. Refresh before retrying. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function push(
  cwd: string,
  action: Extract<ButAction, { kind: "push" }>,
  before: GitCheckoutIdentity,
  signal: AbortSignal,
): Promise<ButActionResult> {
  let details = await state(cwd, signal);
  const remote = details.pushRemote;
  if (!remote || !before.head || !before.branch)
    throw new ButFailedError("This branch has no commit or configured push remote.");
  if (details.configuredTracking && details.configuredTracking.remote !== remote) {
    throw new ButFailedError(
      "The push remote differs from this branch's upstream. Choose a matching upstream before pushing here.",
    );
  }
  await fetchRemote(cwd, remote, signal);
  await unchanged(cwd, before, signal);
  details = await state(cwd, signal);
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
      throw new ButFailedError(
        ancestor.stderr.trim() || "The remote branch could not be compared.",
      );
    if (ancestor.code === 1 && !action.force)
      throw new ButFailedError(
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
    if (loss.some((commit) => !agreed.has(commit)))
      throw new ButFailedError(
        "Push stopped: the remote has commits this push would delete that you were not asked about. Refresh and confirm them first.",
      );
  }
  await unchanged(cwd, before, signal);
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
      throw new ButFailedError(
        `Published ${before.branch}, but its upstream could not be configured. ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  return DONE;
}

async function rebase(
  cwd: string,
  action: Extract<ButAction, { kind: "pull" | "updateWorkspace" }>,
  before: GitCheckoutIdentity,
  signal: AbortSignal,
): Promise<ButActionResult> {
  await clean(cwd, signal);
  const prior = await state(cwd, signal);
  const remoteBranch = action.kind === "pull" ? prior.tracking : prior.target;
  if (!remoteBranch)
    throw new ButFailedError(
      action.kind === "pull"
        ? "The checked-out branch has no upstream to pull."
        : "The checkout has no configured target or remote default branch.",
    );
  await fetchRemote(cwd, remoteBranch.remote, signal);
  await unchanged(cwd, before, signal);
  const latest = await state(cwd, signal);
  const destination = action.kind === "pull" ? latest.tracking : latest.target;
  if (!destination || !before.head)
    throw new ButFailedError("The branch or its destination no longer exists.");
  const count = Number(
    (
      await runGit(cwd, ["rev-list", "--count", `${before.head}..${destination.head}`], signal)
    ).trim(),
  );
  if (count === 0) return UP_TO_DATE;
  // A merge preview does not predict every intermediate replay conflict, so
  // ask about the branch before a divergent rebase can leave a stopped replay.
  const ancestor = await runGitCommand(
    cwd,
    ["merge-base", "--is-ancestor", before.head, destination.head],
    signal,
  );
  if (ancestor.code !== 0 && ancestor.code !== 1)
    throw new ButFailedError(ancestor.stderr.trim() || "The destination could not be compared.");
  if (ancestor.code === 1 && !action.accepted?.conflicted.includes(before.branch!)) {
    return {
      status: "confirm",
      risk: { conflicted: [before.branch!], overlapsUncommitted: false },
    };
  }
  await unchanged(cwd, before, signal);
  await runGit(cwd, ["rebase", "--no-autostash", destination.head], signal);
  return DONE;
}

async function remove(
  cwd: string,
  before: GitCheckoutIdentity,
  destination: string,
  signal: AbortSignal,
) {
  await unchanged(cwd, before, signal);
  await clean(cwd, signal);
  await runGit(cwd, ["switch", "--detach", destination], signal);
  try {
    await runGit(cwd, ["update-ref", "-d", `refs/heads/${before.branch}`, before.head!], signal);
  } catch (error) {
    const current = await readGitCheckout(cwd, signal);
    let restored = false;
    if (current.branch === null && current.head === destination) {
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
    throw new ButFailedError(
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
      throw new ButFailedError(
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
    throw new ButFailedError(
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
      undefined,
      original
        ? {
            GIT_AUTHOR_NAME: original[1],
            GIT_AUTHOR_EMAIL: original[2],
            GIT_AUTHOR_DATE: original[3],
          }
        : undefined,
    )
  ).trim();
}

async function land(
  cwd: string,
  action: Extract<ButAction, { kind: "land" }>,
  before: GitCheckoutIdentity,
  signal: AbortSignal,
): Promise<ButActionResult> {
  await clean(cwd, signal);
  const initial = await state(cwd, signal);
  if (!initial.target)
    throw new ButFailedError(
      "The checkout has no configured target or remote default branch to land on.",
    );
  await fetchRemote(cwd, initial.target.remote, signal);
  await unchanged(cwd, before, signal);
  const details = await state(cwd, signal);
  const target = details.target;
  if (!target || !before.head || !before.branch)
    throw new ButFailedError("The branch or landing target no longer exists.");
  if (target.name === before.branch)
    throw new ButFailedError("The checked-out branch is already the landing target.");
  const branch = details.workspace.stacks[0]?.branches[0];
  if (!branch?.commits.length) return UP_TO_DATE;
  if (branch.commits.length > 1 !== (action.message !== null))
    throw new ButFailedError(
      "The branch's commits changed. Refresh and choose Land again to confirm its commit message.",
    );
  const message = action.message ?? branch.commits[0]!.message;
  const merge = await runGitCommand(
    cwd,
    ["merge-tree", "--write-tree", target.head, before.head],
    signal,
  );
  if (merge.code === 1)
    throw new ButFailedError(
      "Land stopped before publication: the branch conflicts with its target. Pull the target and resolve the conflicts first.",
    );
  if (merge.code !== 0)
    throw new ButFailedError(
      `The landing tree could not be prepared. Land requires Git 2.38 or newer. ${merge.stderr.trim()}`,
    );
  const tree = merge.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new ButFailedError("Git returned an invalid landing tree.");
  const targetTree = (await runGit(cwd, ["rev-parse", `${target.head}^{tree}`], signal)).trim();
  if (tree === targetTree) return UP_TO_DATE;
  const commit = await landingCommit(
    cwd,
    { head: before.head, parent: target.head, tree, message, single: branch.commits.length === 1 },
    signal,
  );
  await unchanged(cwd, before, signal);
  await clean(cwd, signal);
  await publish(cwd, target.remote, `refs/heads/${target.name}`, commit, target.head, signal);
  try {
    await remove(cwd, before, commit, signal);
  } catch (error) {
    throw new ButFailedError(
      `Published the landing commit to ${target.remote}/${target.name}, but local cleanup stopped. Refresh before another action. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return DONE;
}

/** Called only after resolving and locking the checkout's shared Git directory. */
export async function runGitAction(
  cwd: string,
  action: ButAction,
  signal: AbortSignal,
  observed?: ObservedCheckout,
): Promise<ButActionResult> {
  const before = await readGitCheckout(cwd, signal);
  if (before.kind !== "git" || !before.branch)
    throw new ButFailedError("Choose a named isolated branch before running this action.");
  if (
    observed &&
    (before.branch !== observed.branch ||
      before.head !== observed.head ||
      before.origin !== observed.origin)
  )
    changed();
  if (action.kind !== "updateWorkspace" && action.branch !== before.branch) changed();
  await idle(cwd, signal);
  await notApplied(cwd, before.branch, signal);
  switch (action.kind) {
    case "push":
      return push(cwd, action, before, signal);
    case "pull":
    case "updateWorkspace":
      return rebase(cwd, action, before, signal);
    case "rename":
      await runGit(cwd, ["check-ref-format", "--branch", action.name], signal);
      await unchanged(cwd, before, signal);
      await runGit(cwd, ["branch", "-m", before.branch, action.name], signal);
      return DONE;
    case "delete": {
      await clean(cwd, signal);
      if (!before.head)
        throw new ButFailedError("An unborn branch has no commit to preserve before deletion.");
      await remove(cwd, before, before.head, signal);
      return DONE;
    }
    case "land":
      return land(cwd, action, before, signal);
  }
}
