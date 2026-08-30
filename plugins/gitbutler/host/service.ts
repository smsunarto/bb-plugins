import type { CommitIntent, HostRepositorySnapshot, HunkRevisionKey } from "../shared/domain.ts";
import type { HostCommitResult, HostInspectResult } from "../shared/host-contract.ts";
import { ButCommandError, type FixedButCommands } from "./commands.ts";
import { RepositoryMutationQueue } from "./mutation-queue.ts";
import {
  branchCommitIds,
  buildParsedRepository,
  hunkExists,
  hunkSelector,
  repositoryObservation,
  statusProjection,
  type ParsedRepository,
  type RawStatus023,
} from "./parser.ts";

const MUTATION_DEADLINE_MS = 60_000;

export interface GitButlerHostService {
  inspectRepository(repositoryPath: string, signal: AbortSignal): Promise<HostInspectResult>;
  commitSelection(
    repositoryPath: string,
    intent: CommitIntent,
    signal: AbortSignal,
  ): Promise<HostCommitResult>;
}

export class RepositoryChangingError extends Error {
  constructor() {
    super("GitButler state changed during both inspection attempts");
    this.name = "RepositoryChangingError";
  }
}

async function readCoherentRepository(
  commands: FixedButCommands,
  cwd: string,
  signal: AbortSignal,
): Promise<{ parsed: ParsedRepository; status: RawStatus023 }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await commands.status(cwd, signal);
    const diff = await commands.worktreeDiff(cwd, signal);
    const after = await commands.status(cwd, signal);
    if (statusProjection(before) === statusProjection(after)) {
      return { parsed: buildParsedRepository(after, diff), status: after };
    }
  }
  throw new RepositoryChangingError();
}

function inspectFailure(error: unknown): HostInspectResult {
  if (error instanceof RepositoryChangingError) {
    return {
      kind: "unavailable",
      issue: {
        code: "repository-changing",
        message:
          "GitButler state kept changing during inspection. Retry when the workspace settles.",
      },
    };
  }
  if (error instanceof ButCommandError) {
    switch (error.kind) {
      case "missing":
        return {
          kind: "unavailable",
          issue: {
            code: "gitbutler-not-installed",
            message: "GitButler CLI is not installed on this host.",
          },
        };
      case "unsupported-version":
        return {
          kind: "unavailable",
          issue: { code: "unsupported-gitbutler-version", message: error.message },
        };
      case "invalid-output":
        return {
          kind: "unavailable",
          issue: { code: "invalid-gitbutler-output", message: error.message },
        };
      case "output-limit":
        return {
          kind: "unavailable",
          issue: {
            code: "output-limit",
            message: "GitButler output exceeded the 4 MiB safety limit.",
          },
        };
      case "non-zero":
        return {
          kind: "unavailable",
          issue: {
            code: "not-gitbutler-project",
            message: "GitButler could not inspect this repository.",
          },
        };
      case "cancelled":
      case "timeout":
        return {
          kind: "unavailable",
          issue: {
            code: "host-unreachable",
            message: "The GitButler host command did not complete.",
          },
        };
    }
  }
  return {
    kind: "unavailable",
    issue: {
      code: "not-git-repository",
      message: "The repository path is not available on this host.",
    },
  };
}

function rejected(
  code: Extract<HostCommitResult["outcome"], { kind: "rejected" }>["code"],
  message: string,
  repository: HostRepositorySnapshot | null,
): HostCommitResult {
  return { outcome: { kind: "rejected", code, message }, repository };
}

function uncertain(
  code: Extract<HostCommitResult["outcome"], { kind: "uncertain" }>["code"],
  message: string,
  repository: HostRepositorySnapshot | null,
): HostCommitResult {
  return { outcome: { kind: "uncertain", code, message }, repository };
}

function classifyUncertainFailure(
  error: ButCommandError,
): "cancelled" | "output-limit" | "timeout" | "postcondition-failed" {
  switch (error.kind) {
    case "cancelled":
      return "cancelled";
    case "output-limit":
      return "output-limit";
    case "timeout":
      return "timeout";
    default:
      return "postcondition-failed";
  }
}

async function commitInsideQueue(
  commands: FixedButCommands,
  cwd: string,
  intent: CommitIntent,
  signal: AbortSignal,
): Promise<HostCommitResult> {
  await commands.version(cwd, signal);
  const before = await readCoherentRepository(commands, cwd, signal);
  const selectors = intent.hunkKeys.map((key) => hunkSelector(before.parsed, key));
  if (selectors.some((selector) => selector === null)) {
    return rejected(
      "selection-stale",
      "One or more selected hunks changed. Review the current diff before committing.",
      before.parsed.view,
    );
  }

  const targetBefore = branchCommitIds(before.status, intent.target.branchName);
  if (intent.target.kind === "existing" && targetBefore.matches !== 1) {
    return rejected(
      "target-stale",
      "The selected branch is no longer applied exactly once.",
      before.parsed.view,
    );
  }
  if (intent.target.kind === "new") {
    const branchNames = await commands.branchNames(cwd, signal);
    if (branchNames.has(intent.target.branchName)) {
      return rejected(
        "branch-name-taken",
        `Branch ${intent.target.branchName} already exists.`,
        before.parsed.view,
      );
    }
  }

  let commandFailure: ButCommandError | null = null;
  try {
    await commands.commit(
      cwd,
      {
        branchName: intent.target.branchName,
        message: intent.message,
        hunks: selectors.filter((value): value is NonNullable<typeof value> => value !== null),
      },
      signal,
    );
  } catch (error) {
    if (!(error instanceof ButCommandError)) throw error;
    commandFailure = error;
    if (error.kind === "cancelled") {
      return uncertain(
        "cancelled",
        "The commit call was cancelled. It may have committed. Refresh before another attempt.",
        null,
      );
    }
  }

  let after: Awaited<ReturnType<typeof readCoherentRepository>>;
  try {
    after = await readCoherentRepository(commands, cwd, signal);
  } catch {
    if (commandFailure !== null) {
      return uncertain(
        classifyUncertainFailure(commandFailure),
        "The commit result could not be proven. Refresh before another attempt.",
        null,
      );
    }
    return uncertain(
      "postcondition-failed",
      "GitButler accepted the command, but the result could not be verified.",
      null,
    );
  }

  const targetAfter = branchCommitIds(after.status, intent.target.branchName);
  const newCommitIds = [...targetAfter.commitIds].filter((id) => !targetBefore.commitIds.has(id));
  const committedId = newCommitIds[0];
  const selectedRemain = intent.hunkKeys.some((key: HunkRevisionKey) =>
    hunkExists(after.parsed, key),
  );

  if (newCommitIds.length === 1 && committedId !== undefined && !selectedRemain) {
    return {
      outcome: {
        kind: "committed",
        branchName: intent.target.branchName,
        commitId: committedId,
        committedHunkCount: intent.hunkKeys.length,
      },
      repository: after.parsed.view,
    };
  }

  if (
    commandFailure?.kind === "non-zero" &&
    repositoryObservation(before.parsed) === repositoryObservation(after.parsed)
  ) {
    return rejected(
      "gitbutler-rejected",
      commandFailure.stderr.trim() || "GitButler rejected the commit.",
      after.parsed.view,
    );
  }

  return uncertain(
    commandFailure === null ? "postcondition-failed" : classifyUncertainFailure(commandFailure),
    "The command may have committed, but the postconditions were not conclusive. Refresh before another attempt.",
    after.parsed.view,
  );
}

export function createGitButlerHostService(dependencies: {
  readonly commands: FixedButCommands;
  readonly mutations: RepositoryMutationQueue;
  readonly realpath: (path: string) => Promise<string>;
}): GitButlerHostService {
  return {
    async inspectRepository(repositoryPath, signal) {
      try {
        const cwd = await dependencies.realpath(repositoryPath);
        await dependencies.commands.version(cwd, signal);
        const { parsed } = await readCoherentRepository(dependencies.commands, cwd, signal);
        return { kind: "ready", repository: parsed.view };
      } catch (error) {
        return inspectFailure(error);
      }
    },

    async commitSelection(repositoryPath, intent, signal) {
      const deadline = AbortSignal.timeout(MUTATION_DEADLINE_MS);
      const combinedSignal = AbortSignal.any([signal, deadline]);
      let cwd: string;
      try {
        cwd = await dependencies.realpath(repositoryPath);
      } catch {
        return rejected("repository-unavailable", "The repository path is unavailable.", null);
      }
      try {
        return await dependencies.mutations.run(cwd, combinedSignal, () =>
          commitInsideQueue(dependencies.commands, cwd, intent, combinedSignal),
        );
      } catch (error) {
        if (combinedSignal.aborted) {
          return uncertain(
            signal.aborted ? "cancelled" : "timeout",
            "The commit result is unknown. Refresh before another attempt.",
            null,
          );
        }
        const unavailable = inspectFailure(error);
        return rejected(
          "repository-unavailable",
          unavailable.kind === "unavailable"
            ? unavailable.issue.message
            : "The repository is unavailable.",
          null,
        );
      }
    },
  };
}
