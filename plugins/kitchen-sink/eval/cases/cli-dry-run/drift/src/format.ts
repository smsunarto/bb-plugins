import type { Change, ChangeKind, SyncPlan } from "./plan.ts";

const KIND_ORDER: ChangeKind[] = ["add", "update", "remove"];
const KIND_WIDTH = 6;
const UNITS = ["B", "kB", "MB", "GB"];

/**
 * Renders the whole report: a header naming both trees, one line per change,
 * and a closing summary.
 *
 * Changes are grouped by kind rather than by path, so a long run of removals
 * reads as one block instead of being interleaved with the copies.
 */
export function formatPlan(plan: SyncPlan, elapsedMs: number): string {
  const pathColumn = widestPath(plan.changes);
  const output = [`${plan.source} -> ${plan.target}`];

  for (const entry of groupedByKind(plan.changes)) {
    output.push(formatChange(entry, pathColumn));
  }

  output.push(`${formatCounts(countByKind(plan.changes))} in ${formatDuration(elapsedMs)}`);
  return output.join("\n");
}

/** Widest relative path in the report, used to line up the size column. */
function widestPath(changes: Change[]): number {
  return changes.reduce((longest, entry) => Math.max(longest, entry.path.length), 0);
}

/** The same changes, reordered so every kind appears as one contiguous block. */
function groupedByKind(changes: Change[]): Change[] {
  return KIND_ORDER.flatMap((kind) => changes.filter((entry) => entry.kind === kind));
}

/**
 * Renders one change as an indented row. `pathColumn` is the width the path is
 * padded to so the sizes line up down the report.
 */
export function formatChange(entry: Change, pathColumn: number): string {
  const kindLabel = entry.kind.padEnd(KIND_WIDTH);
  return `  ${kindLabel} ${entry.path.padEnd(pathColumn)}  ${formatBytes(entry.bytes)}`;
}

/**
 * Turns a tally into the summary clause, listing only the kinds that actually
 * occur so an unchanged tree does not report three zeroes.
 */
export function formatCounts(tally: Record<ChangeKind, number>): string {
  const phrases = KIND_ORDER.filter((kind) => tally[kind] > 0).map(
    (kind) => `${tally[kind]} to ${kind}`,
  );
  return phrases.length === 0 ? "nothing to do" : phrases.join(", ");
}

/** Counts changes per kind, including the kinds that did not occur. */
export function countByKind(entries: Change[]): Record<ChangeKind, number> {
  const tally: Record<ChangeKind, number> = { add: 0, update: 0, remove: 0 };
  for (const entry of entries) tally[entry.kind] += 1;
  return tally;
}

/** Renders a duration in whole milliseconds below a second, otherwise seconds. */
export function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)} ms`;
  return `${(elapsedMs / 1000).toFixed(1)} s`;
}

/**
 * Renders a byte count in decimal units. One fractional digit is kept for
 * values below 100 so small notes do not all collapse to the same figure.
 */
export function formatBytes(byteCount: number): string {
  let size = byteCount;
  let unitIndex = 0;
  while (size >= 1000 && unitIndex < UNITS.length - 1) {
    size /= 1000;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || size >= 100 ? 0 : 1;
  return `${size.toFixed(precision)} ${UNITS[unitIndex]}`;
}
