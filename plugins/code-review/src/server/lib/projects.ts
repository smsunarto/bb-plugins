import type { BbPluginApi } from "@get-bb/plugin-sdk";

/*
 * Which bb project a GitHub repository is, and where a thread about one of
 * its pull requests runs. A project is matched by its git remote.
 */

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number];
type ThreadSpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
export type SpawnEnvironment = ThreadSpawnArgs["environment"];

const REMOTE = [
  // https://github.com/o/r(.git), with or without credentials
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  // ssh://git@github.com(:22)/o/r(.git)
  /^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  // git@github.com:o/r(.git)
  /^[^@/\s]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
];

/** `owner/repo` of a github.com remote URL, lowercased. Null for anything else. */
export function gitHubRepository(remoteUrl: string): string | null {
  for (const pattern of REMOTE) {
    const match = pattern.exec(remoteUrl.trim());
    if (match) return `${match[1]}/${match[2]}`.toLowerCase();
  }
  return null;
}

/** The bb project whose remote is `owner/repo` on GitHub, or null. */
export async function findProject(
  bb: BbPluginApi,
  owner: string,
  repo: string,
): Promise<Project | null> {
  const wanted = `${owner}/${repo}`.toLowerCase();
  const projects = await bb.sdk.projects.list();
  return (
    projects.find((p) => p.gitRemoteUrl !== null && gitHubRepository(p.gitRemoteUrl) === wanted) ??
    null
  );
}

export async function requireProject(bb: BbPluginApi, owner: string, repo: string) {
  const project = await findProject(bb, owner, repo);
  if (!project) throw new Error(`Add ${owner}/${repo} as a bb project to review it with Codex.`);
  return project;
}

/**
 * Where a review runs. A ready environment already on the pull request's
 * branch has the code checked out, so it is reused. Otherwise the review
 * gets a fresh worktree on the project's default machine. A fork's branch
 * lives in another repository, so no environment of this project is on it.
 */
export async function reviewEnvironment(
  bb: BbPluginApi,
  project: Project,
  pr: { headRefName: string; isFork: boolean },
): Promise<{ environment: SpawnEnvironment; reused: boolean }> {
  if (!pr.isFork) {
    const ready = await bb.sdk.environments.list({ projectId: project.id, status: "ready" });
    const onBranch = ready.find(
      (environment) => environment.status === "ready" && environment.branchName === pr.headRefName,
    );
    if (onBranch) {
      return { environment: { type: "reuse", environmentId: onBranch.id }, reused: true };
    }
  }
  return { environment: freshWorktree(project), reused: false };
}

/** A new worktree on the project's default machine, so an agent never moves the user's checkout. */
export function freshWorktree(project: Project) {
  const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
  return {
    type: "host" as const,
    ...(source ? { hostId: source.hostId } : {}),
    workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } },
  };
}
