import type { Change, ChangeKind, SyncPlan } from "./plan.ts";

const KIND_ORDER: ChangeKind[] = ["add", "update", "remove"];
const KIND_WIDTH = 6;
const UNITS = ["B", "kB", "MB", "GB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function countByKind(changes: Change[]): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = { add: 0, update: 0, remove: 0 };
  for (const change of changes) counts[change.kind] += 1;
  return counts;
}

export function formatCounts(counts: Record<ChangeKind, number>): string {
  const parts = KIND_ORDER.filter((kind) => counts[kind] > 0).map(
    (kind) => `${counts[kind]} to ${kind}`,
  );
  return parts.length === 0 ? "nothing to do" : parts.join(", ");
}

export function formatChange(change: Change, pathWidth: number): string {
  const label = change.kind.padEnd(KIND_WIDTH);
  return `  ${label} ${change.path.padEnd(pathWidth)}  ${formatBytes(change.bytes)}`;
}

export function formatPlan(plan: SyncPlan, elapsedMs: number): string {
  const lines = [`${plan.source} -> ${plan.target}`];
  const pathWidth = plan.changes.reduce(
    (widest, change) => Math.max(widest, change.path.length),
    0,
  );

  // Grouped by kind rather than by path, so a long run of removals reads as one
  // block instead of being interleaved with the copies.
  for (const kind of KIND_ORDER) {
    for (const change of plan.changes) {
      if (change.kind === kind) lines.push(formatChange(change, pathWidth));
    }
  }

  lines.push(`${formatCounts(countByKind(plan.changes))} in ${formatDuration(elapsedMs)}`);
  return lines.join("\n");
}
