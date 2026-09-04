/** How long a cached project name is trusted before it is read again. */
export const PROJECT_NAME_TTL_MS = 5 * 60_000;

export type ProjectNames = {
  name(projectId: string, fetch: () => Promise<{ name: string }>): Promise<string | null>;
  clear(): void;
};

const caches = new WeakMap<object, ProjectNames>();

export function projectNames(bb: object, now: () => number = Date.now): ProjectNames {
  const existing = caches.get(bb);
  if (existing) return existing;
  const created = createProjectNames(now);
  caches.set(bb, created);
  return created;
}

export function createProjectNames(now: () => number = Date.now): ProjectNames {
  const cache = new Map<string, { name: string; readAt: number }>();
  return {
    async name(projectId, fetch) {
      const cached = cache.get(projectId);
      if (cached !== undefined && now() - cached.readAt < PROJECT_NAME_TTL_MS) {
        return cached.name;
      }
      try {
        const project = await fetch();
        cache.set(projectId, { name: project.name, readAt: now() });
        return project.name;
      } catch {
        return cached?.name ?? null;
      }
    },
    clear() {
      cache.clear();
    },
  };
}

export async function projectName(
  bb: {
    sdk: { projects: { get(args: { projectId: string }): Promise<{ name: string }> } };
  },
  projectId: string,
): Promise<string | null> {
  return projectNames(bb).name(projectId, () => bb.sdk.projects.get({ projectId }));
}
