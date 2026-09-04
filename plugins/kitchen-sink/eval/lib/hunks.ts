export type Range = { start: number; end: number };

const HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/**
 * New-side line ranges per file from `git diff -U0`. A pure deletion has no new
 * lines, so it collapses to the single position where the removed text sat.
 */
export function newSideRanges(diff: string): Map<string, Range[]> {
  const ranges = new Map<string, Range[]>();
  let path: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      path = target === "/dev/null" ? null : target.replace(/^b\//u, "");
      if (path !== null && !ranges.has(path)) ranges.set(path, []);
      continue;
    }
    const header = HEADER.exec(line);
    if (header === null || path === null) continue;
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    ranges.get(path)!.push(count === 0 ? { start, end: start } : { start, end: start + count - 1 });
  }
  return ranges;
}

export function changedPaths(diff: string): string[] {
  return [...newSideRanges(diff).entries()]
    .filter(([, list]) => list.length > 0)
    .map(([path]) => path);
}

export function overlaps(range: Range, list: Range[]): boolean {
  return list.some((other) => range.start <= other.end && other.start <= range.end);
}
