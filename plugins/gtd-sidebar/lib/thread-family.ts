/** The root and its non-archived descendants, following bb's parent links. */
export async function threadFamilyIds(
  rootId: string,
  listChildren: (parentThreadId: string, offset: number) => Promise<readonly FamilyChild[]>,
  pageSize: number,
): Promise<string[]> {
  return (await threadFamily(rootId, listChildren, pageSize)).map((member) => member.id);
}

/** A child as bb's thread list reports it. */
export interface FamilyChild {
  id: string;
  originKind: string | null;
  originPluginId?: string | null;
}

/**
 * `threadFamilyIds` with each descendant as listed, so a caller can check
 * what started it. The root comes first, with only its id.
 */
export async function threadFamily(
  rootId: string,
  listChildren: (parentThreadId: string, offset: number) => Promise<readonly FamilyChild[]>,
  pageSize: number,
): Promise<{ id: string; originPluginId?: string | null }[]> {
  const members: { id: string; originPluginId?: string | null }[] = [{ id: rootId }];
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
        members.push(child);
      }
      if (children.length < pageSize) break;
    }
  }
  return members;
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
