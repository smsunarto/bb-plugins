// Parses macOS `vm_stat` output into the memory a new process could use.

const RECLAIMABLE = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"];

export function parseVmStatAvailableBytes(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/u.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  let pages = 0;
  let matched = false;
  for (const label of RECLAIMABLE) {
    const count = Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, "mu").exec(output)?.[1]);
    if (!Number.isFinite(count)) continue;
    pages += count;
    matched = true;
  }
  return matched ? pages * pageSize : null;
}
