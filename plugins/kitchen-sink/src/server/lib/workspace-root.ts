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

/** The project's checkout on `hostId` when it has one, else its default checkout. */
function projectRoot(project: Project, hostId: string | undefined): WorkspaceRoot {
  const onHost = project.sources.filter((entry) => entry.hostId === hostId);
  const sources = onHost.length > 0 ? onHost : project.sources;
  const source = sources.find((entry) => entry.isDefault) ?? sources[0];
  if (!source) throw new WorkspaceError(`Project ${project.name} has no local checkout.`);
  return { hostId: source.hostId, path: source.path, label: project.name, projectId: project.id };
}

/**
 * Resolve a `workspace=` selector: an `env_` id, a `thr_` id (its current
 * environment), or a project id or name. A project resolves to its checkout on
 * `hostId`, the citing thread's machine, when it has one. Anything else is an
 * explicit error — a citation never falls back to a guessed root.
 */
export async function resolveWorkspace(
  bb: BbPluginApi,
  value: string,
  hostId?: string,
): Promise<WorkspaceRoot> {
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
  return projectRoot(project, hostId);
}

function normalizePath(path: string | null): string | null {
  return path === null ? null : path.replace(/[/\\]+$/, "");
}

/**
 * The environment to diff for a resolved workspace. Environments answer
 * directly. A project source maps to the ready environment at that checkout on
 * the source's own machine: another machine's checkout at the same path is a
 * different working copy.
 */
export async function workspaceEnvironmentId(
  bb: BbPluginApi,
  root: WorkspaceRoot,
): Promise<string> {
  if (root.environmentId) return root.environmentId;
  if (!root.projectId) throw new WorkspaceError(`Workspace ${root.label} has no environment.`);
  const wanted = normalizePath(root.path);
  const environments = await bb.sdk.environments.list({
    projectId: root.projectId,
    hostId: root.hostId,
    status: "ready",
  });
  const environment = environments.find((entry) => normalizePath(entry.path) === wanted);
  if (environment) return environment.id;
  throw new WorkspaceError(
    `Workspace ${root.label} has no bb environment at ${root.path} to diff.`,
  );
}

/**
 * Name the machine in a root's label when it is not `ownHostId`, the citing
 * thread's machine, so a reader can tell two checkouts of one project apart.
 */
export async function labelForeignHost(
  bb: BbPluginApi,
  root: WorkspaceRoot,
  ownHostId: string | undefined,
): Promise<WorkspaceRoot> {
  if (ownHostId === undefined || root.hostId === ownHostId) return root;
  const host = await bb.sdk.hosts.get({ hostId: root.hostId }).catch(() => null);
  return { ...root, label: `${root.label} on ${host?.name ?? root.hostId}` };
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
