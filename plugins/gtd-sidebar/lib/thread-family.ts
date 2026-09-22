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
