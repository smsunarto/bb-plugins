/** How long a project's naming rules are trusted before a background re-read. */
const FRESH_MS = 5 * 60_000;
/** A host that does not answer in time leaves the rules unknown until the next try. */
const READ_DEADLINE_MS = 5_000;
const MAX_PROJECTS = 200;

/**
 * A project's `.agents/GTD_NAMING.md` rules, held in memory so the synchronous
 * agent `configure` callback can inline them. Keyed by project, because every
 * worktree of a project carries the same file and a new worktree is otherwise
 * always a cold read.
 */
export interface ProjectTitleRulesCache {
  /**
   * The rules last read for a project: "" when it has none, `undefined` before
   * the first read finishes. Starts a background read through the given
   * environment when the entry is missing or stale; never waits for it.
   */
  peek(projectId: string, environmentId: string | null): string | undefined;
  /** Records rules another reader already loaded, such as automatic naming. */
  remember(projectId: string, rules: string): void;
}

/**
 * `load` returns the normalized rules, "" when the project has none, or `null`
 * when the environment cannot answer yet (still provisioning).
 */
export function createProjectTitleRulesCache(
  load: (environmentId: string) => Promise<string | null>,
  options: { now?: () => number; onError?: (error: unknown) => void } = {},
): ProjectTitleRulesCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { rules: string; readAt: number }>();
  const pending = new Set<string>();

  const remember = (projectId: string, rules: string) => {
    entries.delete(projectId);
    entries.set(projectId, { rules, readAt: now() });
    if (entries.size > MAX_PROJECTS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  };

  const refresh = (projectId: string, environmentId: string) => {
    if (pending.has(projectId)) return;
    pending.add(projectId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_DEADLINE_MS);
    });
    void Promise.race([load(environmentId), deadline])
      .then((rules) => {
        if (rules !== null) remember(projectId, rules);
        return undefined;
      })
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        clearTimeout(timer);
        pending.delete(projectId);
      });
  };

  return {
    peek(projectId, environmentId) {
      const entry = entries.get(projectId);
      if (environmentId !== null && (entry === undefined || now() - entry.readAt > FRESH_MS)) {
        refresh(projectId, environmentId);
      }
      return entry?.rules;
    },
    remember,
  };
}
