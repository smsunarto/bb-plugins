// Parsers for git's NUL-delimited diff and status porcelain, plus the
// aggregation into the wire shape the panel renders. Pure functions, no I/O —
// server.ts runs the commands and feeds their stdout in here.

export type DiffStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked";

export type DiffCounts = { additions: number | null; deletions: number | null };

export type DiffEntry = {
  status: DiffStatus;
  path: string;
  previousPath: string | null;
};

export type DiffFile = DiffEntry & DiffCounts;

export type ChangeSet = {
  additions: number;
  deletions: number;
  files: DiffFile[];
  truncated: boolean;
};

export const MAX_DIFF_FILES = 300;

// `git diff --numstat -z`: records are "adds\tdels\tpath\0"; a rename drops
// the joined path and appends "\0old\0new\0" instead. Keyed by the new path.
// Counts are "-" for binary files, which become null.
export function parseNumstatZ(stdout: string): Map<string, DiffCounts> {
  const counts = new Map<string, DiffCounts>();
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!match) continue;
    const additions = match[1] === "-" ? null : Number(match[1]);
    const deletions = match[2] === "-" ? null : Number(match[2]);
    let path = match[3];
    if (!path) {
      i += 2; // rename: skip the old path, take the new one
      path = tokens[i] ?? "";
    }
    if (path) counts.set(path, { additions, deletions });
  }
  return counts;
}

function mapStatusLetter(letter: string): DiffStatus {
  switch (letter[0]) {
    case "A":
    case "C": // a copy is an addition of the new path
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

// `git diff --name-status -z`: "M\0path\0"; renames and copies are
// "R100\0old\0new\0" — old path first.
export function parseNameStatusZ(stdout: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const status = mapStatusLetter(token);
    if (token.startsWith("R") || token.startsWith("C")) {
      const previousPath = tokens[++i] ?? null;
      const path = tokens[++i] ?? "";
      if (path) entries.push({ status, path, previousPath });
    } else {
      const path = tokens[++i] ?? "";
      if (path) entries.push({ status, path, previousPath: null });
    }
  }
  return entries;
}

// `git status --porcelain=v1 -z`: "XY path\0". A staged rename is
// "R  new\0old\0" — new path first, the opposite order of name-status.
export function parsePorcelainZ(stdout: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const x = token[0];
    const y = token[1];
    const path = token.slice(3);
    let previousPath: string | null = null;
    let status: DiffStatus;
    if (x === "?") {
      status = "untracked";
    } else if (x === "R" || y === "R" || x === "C") {
      status = x === "C" ? "added" : "renamed";
      previousPath = tokens[++i] ?? null;
    } else if (x === "A") {
      status = "added";
    } else if (x === "D" || y === "D") {
      status = "deleted";
    } else {
      status = "modified";
    }
    entries.push({ status, path, previousPath });
  }
  return entries;
}

export function buildChangeSet(
  entries: DiffEntry[],
  counts: Map<string, DiffCounts>,
): ChangeSet {
  let additions = 0;
  let deletions = 0;
  const files: DiffFile[] = [];
  for (const entry of entries) {
    const count = counts.get(entry.path) ?? { additions: null, deletions: null };
    additions += count.additions ?? 0;
    deletions += count.deletions ?? 0;
    files.push({ ...entry, ...count });
  }
  return {
    additions,
    deletions,
    files: files.slice(0, MAX_DIFF_FILES),
    truncated: files.length > MAX_DIFF_FILES,
  };
}

// `wc -l` output: "  <lines> <path>", plus a trailing "total" line for
// multiple inputs. Paths are passed as "./<path>", so strip that back off.
export function parseWcLines(stdout: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (!match || match[2] === "total") continue;
    lines.set(match[2].replace(/^\.\//, ""), Number(match[1]));
  }
  return lines;
}
