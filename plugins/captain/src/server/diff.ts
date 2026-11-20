/**
 * A line-based unified diff, small enough for instruction files (a few hundred
 * lines). An LCS table, then hunks with `context` lines around each change.
 */

type Op = { kind: " " | "-" | "+"; line: string };

export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = lineOps(a, b);
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";

  // Group changes whose context windows touch into one hunk.
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  }

  const out: string[] = [];
  for (const [start, end] of ranges) {
    const aStart = ops.slice(0, start).filter((op) => op.kind !== "+").length;
    const bStart = ops.slice(0, start).filter((op) => op.kind !== "-").length;
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((op) => op.kind !== "+").length;
    const bLen = hunk.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
  }
  return out.join("\n");
}

function lineOps(a: readonly string[], b: readonly string[]): Op[] {
  const lcs = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const same = i < a.length && j < b.length && a[i] === b[j];
    // Take from `b` when `a` is used up, or when skipping `b[j]` keeps the longer common run.
    const add = !same && j < b.length && (i === a.length || at(lcs, i, j + 1) >= at(lcs, i + 1, j));
    if (same) {
      ops.push({ kind: " ", line: a[i] as string });
      i++;
      j++;
    } else if (add) {
      ops.push({ kind: "+", line: b[j] as string });
      j++;
    } else {
      ops.push({ kind: "-", line: a[i] as string });
      i++;
    }
  }
  return removalsFirst(ops);
}

/** `lcs[i][j]`: the length of the longest common subsequence of `a[i..]` and `b[j..]`. */
function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const lcs = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] =
        a[i] === b[j] ? at(lcs, i + 1, j + 1) + 1 : Math.max(at(lcs, i + 1, j), at(lcs, i, j + 1));
    }
  }
  return lcs;
}

function at(table: number[][], i: number, j: number): number {
  return table[i]?.[j] ?? 0;
}

/** Show each run of changes as its removals, then its additions, as diff tools do. */
function removalsFirst(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  let run: Op[] = [];
  const flush = () => {
    out.push(...run.filter((op) => op.kind === "-"), ...run.filter((op) => op.kind === "+"));
    run = [];
  };
  for (const op of ops) {
    if (op.kind === " ") {
      flush();
      out.push(op);
    } else run.push(op);
  }
  flush();
  return out;
}
