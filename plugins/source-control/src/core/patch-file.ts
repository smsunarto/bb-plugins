/**
 * A `.patch` or `.diff` file read into the files it changes, so the Files
 * view's cards can draw it. Takes `git diff`, `git show` and `git log -p`
 * output, `git format-patch` mail (one or many commits), and plain
 * `diff -u` output. Each file's text is cut out whole for Pierre to parse;
 * hunks are walked by their line counts, so a removed line that reads
 * `--- x` or `diff --git` stays inside its hunk.
 *
 * Text with no file in it reads as null: the opener then shows it as text.
 */
import type { FilePatch } from "./change.ts";
import type { ChangeFile } from "./review.ts";

export type PatchFileEntry = { file: ChangeFile; patch: FilePatch };

export type PatchFileCommit = {
  /** The commit's hash, from a `From <sha>` mail line or a `commit <sha>` line. */
  id: string | null;
  subject: string | null;
  author: string | null;
  date: string | null;
  files: PatchFileEntry[];
};

export type PatchFile = {
  commits: PatchFileCommit[];
  files: number;
  additions: number;
  deletions: number;
};

/** `git format-patch`'s mail separator, with its fixed date, and `git log`'s commit line. */
const COMMIT_START =
  /^(?:From ([0-9a-f]{40}|[0-9a-f]{64}) Mon Sep 17 00:00:00 2001$|commit ([0-9a-f]{40}|[0-9a-f]{64})\b)/;
/** What follows `git log`'s commit line, so a message line reading "commit 1a2b…" is not one. */
const LOG_FIELD = /^(?:Merge|Author|AuthorDate|Commit|CommitDate|Date):/;

/** Whether the line at `index` starts a commit. */
function commitStarts(lines: string[], index: number): boolean {
  const match = COMMIT_START.exec(lines[index]!);
  if (!match) return false;
  return match[1] !== undefined || LOG_FIELD.test(lines[index + 1] ?? "");
}
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

type Draft = {
  start: number;
  end: number;
  git: boolean;
  /** Paths from `diff --git`, `---`/`+++`, and rename or copy lines, before stripping. */
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  copied: boolean;
  added: boolean;
  deleted: boolean;
  binary: boolean;
  hunks: number;
  additions: number;
  deletions: number;
};

export function readPatchFile(text: string): PatchFile | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const commits: PatchFileCommit[] = [];
  let index = 0;
  while (index < lines.length) {
    const read = readCommit(lines, index);
    index = read.next;
    commits.push(...uniquePaths(read.commit));
  }
  const all = commits.flatMap((commit) => commit.files);
  if (all.length === 0) return null;
  return {
    commits,
    files: all.length,
    additions: all.reduce((sum, entry) => sum + entry.file.additions, 0),
    deletions: all.reduce((sum, entry) => sum + entry.file.deletions, 0),
  };
}

/**
 * A commit's files in runs with no path twice, as a card and its patch are
 * keyed by path. A commit with no file (an empty commit, a preamble) has
 * nothing to draw.
 */
function uniquePaths(commit: PatchFileCommit): PatchFileCommit[] {
  const runs: PatchFileCommit[] = [];
  let seen = new Set<string>();
  for (const entry of commit.files) {
    if (runs.length === 0 || seen.has(entry.file.path)) {
      runs.push({ ...commit, files: [] });
      seen = new Set();
    }
    seen.add(entry.file.path);
    runs.at(-1)!.files.push(entry);
  }
  return runs;
}

/** One commit from `start`: its header, then its files, up to the next commit's first line. */
function readCommit(lines: string[], start: number): { commit: PatchFileCommit; next: number } {
  const head = readHeader(lines, start);
  const scanner = new FileScanner(lines);
  let index = head.next;
  while (index < lines.length) {
    if (index > start && commitStarts(lines, index)) break;
    index = scanner.read(index);
  }
  scanner.finish();
  return { commit: { ...head.meta, files: scanner.files }, next: index };
}

/** Whether a git file is still in its extended header, before its first hunk. */
const inGitHeader = (draft: Draft) => draft.git && draft.hunks === 0;

class FileScanner {
  readonly files: PatchFileEntry[] = [];
  private draft: Draft | null = null;

  private readonly lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  /** Reads the line at `index` into the current file, or starts or ends one; returns the next index. */
  read(index: number): number {
    const line = this.lines[index]!;
    if (line.startsWith("diff --git ")) {
      const draft = this.start(index, true);
      [draft.gitOld, draft.gitNew] = splitGitPaths(line.slice("diff --git ".length));
      return index + 1;
    }
    if (line.startsWith("--- ") && this.lines[index + 1]?.startsWith("+++ "))
      return this.names(index);
    const draft = this.draft;
    const hunk = draft ? HUNK.exec(line) : null;
    if (draft && hunk) return readHunk(this.lines, index, hunk, draft);
    if (draft && inGitHeader(draft) && readGitHeader(line, draft)) {
      draft.end = index + 1;
      return line === "GIT binary patch" ? skipBinary(this.lines, index + 1, draft) : index + 1;
    }
    // Anything else ends the file: a mail signature, a commit message, stray text.
    this.finish();
    return index + 1;
  }

  finish(): void {
    if (this.draft) this.files.push(toEntry(this.draft, this.lines));
    this.draft = null;
  }

  private start(index: number, git: boolean): Draft {
    this.finish();
    this.draft = newDraft(index, git);
    this.draft.end = index + 1;
    return this.draft;
  }

  /** A `---`/`+++` pair: a git file's own until its first hunk, otherwise a new plain-diff file. */
  private names(index: number): number {
    const own = this.draft && inGitHeader(this.draft) && this.draft.oldPath === null;
    const draft = own ? this.draft! : this.start(index, false);
    draft.oldPath = headerPath(this.lines[index]!.slice(4));
    draft.newPath = headerPath(this.lines[index + 1]!.slice(4));
    draft.end = index + 2;
    return index + 2;
  }
}

function newDraft(start: number, git: boolean): Draft {
  return {
    start,
    end: start,
    git,
    gitOld: null,
    gitNew: null,
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    copied: false,
    added: false,
    deleted: false,
    binary: false,
    hunks: 0,
    additions: 0,
    deletions: 0,
  };
}

/** Walks a hunk by its counts. A blank line counts as context, as some editors strip the space. */
function readHunk(lines: string[], start: number, hunk: RegExpExecArray, draft: Draft): number {
  let old = hunk[1] === undefined ? 1 : Number(hunk[1]);
  let next = hunk[2] === undefined ? 1 : Number(hunk[2]);
  draft.hunks++;
  let index = start + 1;
  while (index < lines.length && (old > 0 || next > 0)) {
    const line = lines[index]!;
    const mark = line[0];
    if (mark === "+" && next > 0) {
      next--;
      draft.additions++;
    } else if (mark === "-" && old > 0) {
      old--;
      draft.deletions++;
    } else if ((mark === " " || line === "") && old > 0 && next > 0) {
      old--;
      next--;
    } else if (mark !== "\\") break;
    index++;
  }
  // "\ No newline at end of file" after the hunk's last line.
  while (lines[index]?.startsWith("\\")) index++;
  draft.end = index;
  return index;
}

/** Consumes a git file's extended header line; false when the line is not one. */
function readGitHeader(line: string, draft: Draft): boolean {
  if (line.startsWith("new file mode")) draft.added = true;
  else if (line.startsWith("deleted file mode")) draft.deleted = true;
  else if (line.startsWith("rename from ")) draft.renameFrom = unquote(line.slice(12));
  else if (line.startsWith("rename to ")) draft.renameTo = unquote(line.slice(10));
  else if (line.startsWith("copy from ")) {
    draft.renameFrom = unquote(line.slice(10));
    draft.copied = true;
  } else if (line.startsWith("copy to ")) draft.renameTo = unquote(line.slice(8));
  else if (/^Binary files .* differ$/.test(line) || line === "GIT binary patch")
    draft.binary = true;
  else if (!/^(?:index |old mode |new mode |similarity index |dissimilarity index )/.test(line))
    return false;
  return true;
}

/** A `GIT binary patch` body: `literal`/`delta` blocks of base85 lines, each ended by a blank line. */
function skipBinary(lines: string[], start: number, draft: Draft): number {
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (
      /^(?:literal|delta) \d+$/.test(line) ||
      /^[A-Za-z][0-9A-Za-z!#$%&()*+;<=>?@^_`{|}~-]+$/.test(line)
    )
      index++;
    else if (line === "" && /^(?:literal|delta) \d+$/.test(lines[index + 1] ?? "")) index++;
    else if (line === "") {
      index++;
      break;
    } else break;
  }
  draft.end = index;
  return index;
}

const stripPrefix = (path: string | null, prefix: "a/" | "b/") =>
  path !== null && path !== "/dev/null" && path.startsWith(prefix) ? path.slice(2) : path;

/** The file's old and new paths, `/dev/null` for a side that does not exist. */
function pathsOf(draft: Draft): [string | null, string | null] {
  if (draft.git)
    return [
      draft.renameFrom ?? stripPrefix(draft.oldPath ?? draft.gitOld, "a/"),
      draft.renameTo ?? stripPrefix(draft.newPath ?? draft.gitNew, "b/"),
    ];
  // `diff -u` names files as given; git-style a/ b/ prefixes only when both sides carry them.
  const prefixed = draft.oldPath?.startsWith("a/") && draft.newPath?.startsWith("b/");
  return prefixed
    ? [stripPrefix(draft.oldPath, "a/"), stripPrefix(draft.newPath, "b/")]
    : [draft.oldPath, draft.newPath];
}

function kindOf(draft: Draft, oldPath: string | null, newPath: string | null): ChangeFile["kind"] {
  if (draft.added || oldPath === "/dev/null") return "added";
  if (draft.deleted || newPath === "/dev/null") return "deleted";
  if (draft.renameFrom === null || draft.renameTo === null) return "modified";
  return draft.copied ? "copied" : "renamed";
}

function toEntry(draft: Draft, lines: string[]): PatchFileEntry {
  const [oldPath, newPath] = pathsOf(draft);
  const kind = kindOf(draft, oldPath, newPath);
  const path = (kind === "deleted" ? oldPath : newPath) ?? oldPath ?? "(unknown file)";
  const previousPath = kind === "renamed" || kind === "copied" ? draft.renameFrom : null;
  // No hunks (binary, a pure rename, a mode change) leaves nothing for Pierre: the card says why.
  const patch =
    draft.binary || draft.hunks === 0 ? "" : `${lines.slice(draft.start, draft.end).join("\n")}\n`;
  return {
    file: {
      path,
      kind,
      previousPath,
      additions: draft.additions,
      deletions: draft.deletions,
      binary: draft.binary,
    },
    patch: { path, kind, previousPath, patch, truncated: false },
  };
}

/** `a/x b/x` when unquoted and possibly spaced; quoted halves are unquoted. */
function splitGitPaths(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0);
    if (end < 0) return [null, null];
    const old = unquote(rest.slice(0, end + 1));
    return [old, unquote(rest.slice(end + 2))];
  }
  if (rest.endsWith('"')) {
    const open = rest.lastIndexOf(' "');
    if (open >= 0) return [rest.slice(0, open), unquote(rest.slice(open + 1))];
  }
  // Both sides name the same file, except for a rename: halves of equal length first.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3))
    return [rest.slice(0, half), rest.slice(half + 1)];
  const split = rest.indexOf(" b/");
  return split < 0 ? [null, null] : [rest.slice(0, split), rest.slice(split + 1)];
}

/** A `---`/`+++` path, without `diff -u`'s timestamp after a tab. */
function headerPath(value: string): string {
  const path = value.startsWith('"') ? unquote(value.slice(0, closingQuote(value, 0) + 1)) : value;
  return path.split("\t")[0]!.trimEnd();
}

function closingQuote(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index;
  }
  return -1;
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  '"': '"',
  "\\": "\\",
  a: "\x07",
  b: "\b",
  f: "\f",
  r: "\r",
  v: "\v",
};

/** Git's C-style quoted path, octal escapes read as UTF-8 bytes. */
export function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const encoder = new TextEncoder();
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      const next = body[++index] ?? "";
      bytes.push(...encoder.encode(ESCAPES[next] ?? next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ── Commit headers ─────────────────────────────────────────────────────

type Meta = Omit<PatchFileCommit, "files">;

/** The mail or `git log` header at `start`, when there is one; `next` is where files may begin. */
function readHeader(lines: string[], start: number): { meta: Meta; next: number } {
  const meta: Meta = { id: null, subject: null, author: null, date: null };
  const first =
    start < lines.length && commitStarts(lines, start) ? COMMIT_START.exec(lines[start]!) : null;
  if (!first) return { meta, next: start };
  meta.id = first[1] ?? first[2] ?? null;
  const next = first[1]
    ? readMailHeader(lines, start + 1, meta)
    : readLogHeader(lines, start + 1, meta);
  return { meta, next };
}

/** Mail headers, folded lines joined, up to the blank line before the message. */
function readMailHeader(lines: string[], start: number, meta: Meta): number {
  let index = start;
  let last: string | null = null;
  for (; index < lines.length && lines[index] !== ""; index++) {
    const line = lines[index]!;
    const folded = /^\s/.test(line) && last === "Subject" && meta.subject !== null;
    if (folded) {
      meta.subject += ` ${line.trim()}`;
      continue;
    }
    const field = /^([A-Za-z-]+): ?(.*)$/.exec(line);
    last = field?.[1] ?? null;
    const value = field?.[2] ?? "";
    if (last === "From") meta.author = decodeWords(value);
    else if (last === "Date") meta.date = value;
    else if (last === "Subject") meta.subject = value;
  }
  if (meta.subject !== null)
    meta.subject = decodeWords(meta.subject).replace(/^\[[^\]]*\]\s*/, "") || null;
  return index;
}

/** `git log`/`git show`: Author and Date, then the message indented four spaces. */
function readLogHeader(lines: string[], start: number, meta: Meta): number {
  let index = start;
  for (; index < lines.length && lines[index] !== ""; index++) {
    const field = /^(Author|Date|AuthorDate):\s*(.*)$/.exec(lines[index]!);
    if (field?.[1] === "Author") meta.author = field[2]!;
    else if (field) meta.date = field[2]!;
  }
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === "") continue;
    if (!line.startsWith("    ")) break;
    meta.subject ??= line.trim();
  }
  return index;
}

/** RFC 2047 encoded words (`=?UTF-8?q?...?=`), as format-patch writes a non-ASCII name or subject. */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g,
      (whole, charset: string, encoding: string, data: string) => {
        try {
          const bytes =
            encoding.toLowerCase() === "b"
              ? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
              : Uint8Array.from(
                  data
                    .replace(/_/g, " ")
                    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                      String.fromCharCode(Number.parseInt(hex, 16)),
                    ),
                  (char) => char.charCodeAt(0),
                );
          return new TextDecoder(charset).decode(bytes);
        } catch {
          return whole;
        }
      },
    );
}
