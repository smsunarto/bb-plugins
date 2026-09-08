export type DiffStats = { additions: number; deletions: number };

/** Count the displayed hunk lines, not file headers or patch metadata. */
export function countPatchChanges(patch: string): DiffStats | null {
  const stats: DiffStats = { additions: 0, deletions: 0 };
  let oldRemaining = 0;
  let newRemaining = 0;
  let foundHunk = false;
  for (const line of patch.split(/\r?\n/u)) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
    if (header !== null) {
      if (oldRemaining !== 0 || newRemaining !== 0) return null;
      oldRemaining = Number(header[1] ?? 1);
      newRemaining = Number(header[2] ?? 1);
      foundHunk = true;
      continue;
    }
    if (oldRemaining === 0 && newRemaining === 0) continue;
    if (line.startsWith("\\")) continue;
    switch (line[0]) {
      case "+":
        stats.additions += 1;
        newRemaining -= 1;
        break;
      case "-":
        stats.deletions += 1;
        oldRemaining -= 1;
        break;
      case " ":
        oldRemaining -= 1;
        newRemaining -= 1;
        break;
      default:
        return null;
    }
    if (oldRemaining < 0 || newRemaining < 0) return null;
  }
  return foundHunk && oldRemaining === 0 && newRemaining === 0 ? stats : null;
}
