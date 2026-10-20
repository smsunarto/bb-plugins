/** The root and its non-archived descendants, following bb's parent links. */
export async function threadFamilyIds(
  rootId: string,
  listChildren: (
    parentThreadId: string,
    offset: number,
  ) => Promise<readonly { id: string; originKind: string | null }[]>,
  pageSize: number,
): Promise<string[]> {
  const ids = [rootId];
  const seen = new Set(ids);
  for (let index = 0; index < ids.length; index++) {
    const parentId = ids[index]!;
    for (let offset = 0; ; offset += pageSize) {
      const children = await listChildren(parentId, offset);
      for (const child of children) {
        // A fork retains its source as a bb link, but is its own inbox family.
        if (child.originKind === "fork" || seen.has(child.id)) continue;
        seen.add(child.id);
        ids.push(child.id);
      }
      if (children.length < pageSize) break;
    }
  }
  return ids;
}

/**
 * The same family read from a roster already in hand — the sidebar's own
 * threads — so a snooze can move it before the backend has walked bb's. The
 * backend's answer still decides which rows were written.
 */
export function rosterFamilyIds(
  threads: readonly {
    id: string;
    parentThreadId: string | null;
    originKind: string | null;
    isArchived: boolean;
  }[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null || thread.originKind === "fork" || thread.isArchived) {
      continue;
    }
    const siblings = children.get(thread.parentThreadId);
    if (siblings) siblings.push(thread.id);
    else children.set(thread.parentThreadId, [thread.id]);
  }
  const ids = [rootId];
  const seen = new Set(ids);
  for (let index = 0; index < ids.length; index++) {
    for (const childId of children.get(ids[index]!) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      ids.push(childId);
    }
  }
  return ids;
}
