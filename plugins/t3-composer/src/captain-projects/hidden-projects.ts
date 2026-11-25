// The bb projects Captains live in, which new-thread project choices leave out. The new-thread
// composer reads them from the Captain plugin and publishes them here; the picker content
// script and the composer's fallback read them back.
//
// The last answer is kept in localStorage, keyed by the page's origin (one bb server per
// origin), so a page load hides and redirects at once instead of after the read answers. A
// failed read keeps the cached ids. Without Captain, and before it has ever answered, the list
// is empty and nothing is hidden.

/** BB's personal project: "Don't work in a project", what BB itself falls back to. */
export const PERSONAL_PROJECT_ID = "proj_personal";

const STORAGE_PREFIX = "t3-composer.captain-project-ids:";

function storageKey(): string | null {
  try {
    return `${STORAGE_PREFIX}${globalThis.location.origin}`;
  } catch {
    return null;
  }
}

function readCached(): readonly string[] {
  const key = storageKey();
  if (key === null) return [];
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeCached(ids: readonly string[]) {
  const key = storageKey();
  if (key === null) return;
  try {
    if (ids.length === 0) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Storage full or blocked: the ids still apply for this page.
  }
}

function normalize(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

let hidden: readonly string[] = normalize(readCached());
let lastVisibleProjectId: string | null = null;
const listeners = new Set<() => void>();

/** The hidden ids; the same array until they change, so it can back `useSyncExternalStore`. */
export function hiddenProjectIds(): readonly string[] {
  return hidden;
}

/** Replaces and caches the hidden ids; listeners hear only a real change. */
export function publishHiddenProjectIds(ids: readonly string[]): void {
  const next = normalize(ids);
  if (next.length === hidden.length && next.every((id, index) => id === hidden[index])) return;
  hidden = next;
  writeCached(next);
  for (const listener of listeners) listener();
}

export function subscribeHiddenProjectIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notes a project the new-thread composer settled on that is not hidden. */
export function rememberVisibleProject(projectId: string): void {
  lastVisibleProjectId = projectId;
}

/**
 * Where a new-thread composer on `projectId` should move, or null to stay. A hidden project,
 * picked by hand or remembered from an earlier visit, moves to the last visible project this
 * window used, else to the personal project as BB does for a project it does not know.
 */
export function fallbackProjectId(
  projectId: string | null,
  ids: readonly string[] = hidden,
  lastVisible: string | null = lastVisibleProjectId,
): string | null {
  if (projectId === null || !ids.includes(projectId)) return null;
  return lastVisible !== null && !ids.includes(lastVisible) ? lastVisible : PERSONAL_PROJECT_ID;
}

/** Test-only: reloads the ids from storage, as a page load does, and forgets the rest. */
export function resetHiddenProjects(): void {
  hidden = normalize(readCached());
  lastVisibleProjectId = null;
  listeners.clear();
}
