import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CommitIntent, RepositoryState } from "../shared/domain.ts";
import { gitButlerHostContract, type HostCommitResult } from "../shared/host-contract.ts";

type RepositoryIssue = Extract<RepositoryState, { kind: "unavailable" }>["issue"];

type RepositoryRoute =
  | {
      readonly kind: "routed";
      readonly environmentId: string;
      readonly hostId: string;
      readonly repositoryPath: string;
      readonly threadStatus: string;
    }
  | { readonly kind: "unavailable"; readonly issue: RepositoryIssue };

function unavailable(code: RepositoryIssue["code"], message: string): RepositoryRoute {
  return { kind: "unavailable", issue: { code, message } };
}

export async function resolveRepositoryRoute(
  bb: BbPluginApi,
  threadId: string,
): Promise<RepositoryRoute> {
  let thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  try {
    thread = await bb.sdk.threads.get({ threadId });
  } catch {
    return unavailable("thread-unavailable", "This BB thread is no longer available.");
  }
  if (thread.environmentId === null) {
    return unavailable("no-environment", "This thread has no workspace environment.");
  }

  let environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
  try {
    environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  } catch {
    return unavailable("environment-not-ready", "This thread's environment is unavailable.");
  }
  if (environment.status !== "ready") {
    return unavailable(
      "environment-not-ready",
      `This thread's environment is ${environment.status}. Retry when it is ready.`,
    );
  }
  if (!environment.isGitRepo) {
    return unavailable("not-git-repository", "This thread is not working in a Git repository.");
  }
  if (environment.isWorktree) {
    return unavailable(
      "linked-worktree",
      "GitButler does not support this linked worktree. Use the repository's primary checkout.",
    );
  }
  if (environment.path === null) {
    return unavailable("workspace-path-missing", "This environment has no workspace path.");
  }
  return {
    kind: "routed",
    environmentId: environment.id,
    hostId: environment.hostId,
    repositoryPath: environment.path,
    threadStatus: thread.status,
  };
}

function withEnvironment(
  environmentId: string,
  repository: HostCommitResult["repository"],
): RepositoryState | null {
  return repository === null
    ? null
    : { kind: "ready", repository: { ...repository, environmentId } };
}

export async function readRepository(bb: BbPluginApi, threadId: string): Promise<RepositoryState> {
  const route = await resolveRepositoryRoute(bb, threadId);
  if (route.kind === "unavailable") return route;
  const client = bb.hosts.experimental_client({ contract: gitButlerHostContract });
  const result = await client.call(
    "inspectRepository",
    { repositoryPath: route.repositoryPath },
    { hostId: route.hostId },
  );
  return result.kind === "unavailable"
    ? result
    : {
        kind: "ready",
        repository: { ...result.repository, environmentId: route.environmentId },
      };
}

export async function commitRepositorySelection(
  bb: BbPluginApi,
  threadId: string,
  intent: CommitIntent,
): Promise<{ outcome: HostCommitResult["outcome"]; repository: RepositoryState | null }> {
  const route = await resolveRepositoryRoute(bb, threadId);
  if (route.kind === "unavailable") {
    return {
      outcome: { kind: "rejected", code: "repository-unavailable", message: route.issue.message },
      repository: route,
    };
  }
  if (["starting", "active", "stopping"].includes(route.threadStatus)) {
    return {
      outcome: {
        kind: "rejected",
        code: "thread-active",
        message: "Wait for the thread agent to become idle before committing.",
      },
      repository: null,
    };
  }

  const client = bb.hosts.experimental_client({ contract: gitButlerHostContract });
  try {
    const result = await client.call(
      "commitSelection",
      { repositoryPath: route.repositoryPath, intent },
      { hostId: route.hostId },
    );
    return {
      outcome: result.outcome,
      repository: withEnvironment(route.environmentId, result.repository),
    };
  } catch {
    return {
      outcome: {
        kind: "uncertain",
        code: "host-call-failed",
        message:
          "The host call failed after submission. The command may have committed. Refresh before retrying.",
      },
      repository: null,
    };
  }
}
