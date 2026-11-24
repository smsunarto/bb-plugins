/**
 * bb 0.50 caches sidebar thread objects per entry. useHiddenWorkerActivity
 * still creates a new object for each thread with a running hidden worker
 * whenever the sidebar list changes. Reusing the previous object when its
 * data is equal lets memoized rows skip renders for unrelated renames.
 * Returns `previous` itself when nothing changed.
 */
export function retainUnchangedThreads<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): readonly T[] {
  const priorById = new Map(previous.map((thread) => [thread.id, thread]));
  let changed = previous.length !== next.length;
  const retained = next.map((thread, index) => {
    const prior = priorById.get(thread.id);
    const kept = prior !== undefined && sameData(prior, thread) ? prior : thread;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? retained : previous;
}

/** Structural equality for the plain JSON-shaped data bb hands plugins. */
function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameData(leftRecord[key], rightRecord[key]),
    )
  );
}
