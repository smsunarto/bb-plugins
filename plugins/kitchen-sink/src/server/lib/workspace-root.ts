import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Sdk = BbPluginApi["sdk"];
type Environment = Awaited<ReturnType<Sdk["environments"]["get"]>>;
type Project = Awaited<ReturnType<Sdk["projects"]["list"]>>[number];

/**
 * A filesystem root a citation or diff can resolve against. Environments carry
 * their id so diff targets work unchanged; project sources are plain roots.
 */
export interface WorkspaceRoot {
  hostId: string;
  path: string;
  /** Display label: project or environment name, else the path tail. */
  label: string;
  /** bb environment backing this root, when one is known. */
  environmentId?: string;
  /** Owning project when the root came from a project source. */
  projectId?: string;
}

/** Deliberate, user-presentable failure. Other errors stay generic upstream. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function tail(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).at(-1) ?? path;
}

function environmentRoot(environment: Environment): WorkspaceRoot {
  if (!environment.path)
    throw new WorkspaceError(`Environment ${environment.id} has no readable worktree.`);
  return {
    hostId: environment.hostId,
    path: environment.path,
    label: environment.name ?? tail(environment.path),
    environmentId: environment.id,
  };
}

function projectRoot(project: Project): WorkspaceRoot {
  const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
  if (!source) throw new WorkspaceError(`Project ${project.name} has no local checkout.`);
  return { hostId: source.hostId, path: source.path, label: project.name, projectId: project.id };
}

/**
 * Resolve a `workspace=` selector: an `env_` id, a `thr_` id (its current
 * environment), or a project id or name. Anything else is an explicit error —
 * a citation never falls back to a guessed root.
 */
export async function resolveWorkspace(bb: BbPluginApi, value: string): Promise<WorkspaceRoot> {
  const selector = value.trim();
  try {
    if (selector.startsWith("env_"))
      return environmentRoot(await bb.sdk.environments.get({ environmentId: selector }));
    if (selector.startsWith("thr_")) {
      const thread = await bb.sdk.threads.get({ threadId: selector });
      if (!thread.environmentId)
        throw new WorkspaceError(`Thread ${selector} has no workspace environment.`);
      return environmentRoot(
        await bb.sdk.environments.get({ environmentId: thread.environmentId }),
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(`Unknown workspace "${selector}".`);
  }
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const project =
    projects.find((entry) => entry.id === selector) ??
    projects.find((entry) => entry.name.toLowerCase() === selector.toLowerCase());
  if (!project)
    throw new WorkspaceError(
      `Unknown workspace "${selector}". Use a project name, an env_ id, or a thr_ id.`,
    );
  return projectRoot(project);
}

function normalizePath(path: string | null): string | null {
  return path === null ? null : path.replace(/[/\\]+$/, "");
}

/**
 * The environment to diff for a resolved workspace. Environments answer
 * directly; a project source finds the environment anchored at its checkout,
 * reached through that project's threads (there is no environment list API).
 */
export async function workspaceEnvironmentId(
  bb: BbPluginApi,
  root: WorkspaceRoot,
): Promise<string> {
  if (root.environmentId) return root.environmentId;
  if (!root.projectId) throw new WorkspaceError(`Workspace ${root.label} has no environment.`);
  const wanted = normalizePath(root.path);
  for (const archived of [undefined, true] as const) {
    const threads = await bb.sdk.threads.list({ projectId: root.projectId, archived, limit: 100 });
    const seen = new Set<string>();
    for (const thread of threads) {
      if (!thread.environmentId || seen.has(thread.environmentId)) continue;
      seen.add(thread.environmentId);
      let environment: Environment;
      try {
        environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      } catch {
        continue;
      }
      if (normalizePath(environment.path) === wanted) return environment.id;
    }
  }
  throw new WorkspaceError(
    `Workspace ${root.label} has no bb environment at ${root.path} to diff.`,
  );
}

/** The workspace the containing thread runs in — today's default resolution. */
export async function threadWorkspaceRoot(
  bb: BbPluginApi,
  threadId: string,
): Promise<WorkspaceRoot> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) throw new WorkspaceError("This thread has no workspace environment.");
  return environmentRoot(await bb.sdk.environments.get({ environmentId: thread.environmentId }));
}

/**
 * Project checkouts that can hold a citation when the thread's own workspace
 * cannot: every known project source, the message's project first, deduplicated
 * by host and path.
 */
export async function candidateWorkspaceRoots(
  bb: BbPluginApi,
  projectId: string | null,
  exclude: WorkspaceRoot,
): Promise<WorkspaceRoot[]> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const ordered = [...projects].sort(
    (a, b) => Number(b.id === projectId) - Number(a.id === projectId),
  );
  const excluded = `${exclude.hostId}${exclude.path}`;
  const seen = new Set<string>([excluded]);
  const roots: WorkspaceRoot[] = [];
  for (const project of ordered) {
    const sources = [...project.sources].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    for (const source of sources) {
      const key = `${source.hostId}${source.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({
        hostId: source.hostId,
        path: source.path,
        label: project.name,
        projectId: project.id,
      });
    }
  }
  return roots;
}
