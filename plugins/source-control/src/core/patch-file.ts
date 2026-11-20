/**
 * A `.patch` or `.diff` file read into the files it changes, so the Files
 * view's cards can draw it. Takes `git diff`, `git show` and `git log -p`
 * output, `git format-patch` mail (one or many commits), and plain
 * `diff -u`/`diff -r` output.
 *
 * The diff view shows only what it can show faithfully. Every hunk must hold
 * exactly the lines its header counts, and every file header must be whole;
 * anything else (a miscounted or garbled hunk, prose with a `---`/`+++` pair,
 * a combined merge diff) reads as `{ ok: false, reason }` and the opener
 * shows the file as text with that reason.
 */
import type { FilePatch } from "./change.ts";
import { checkDrawn, CLAIM, isMailTrailer, type DrawnFile, type Section } from "./patch-guard.ts";
import { readStrict, type StrictCommit, type StrictFile, type StrictRead } from "./patch-strict.ts";
import { QUOTED_ESCAPES, quotedPath } from "./quoted-path.ts";
import type { ChangeFile } from "./review.ts";

/** Cards drawn at most; the rest are counted, and the file opens as text to read them. */
export const MAX_PATCH_FILES = 1000;
/** A file's patch past this many characters shows as too large, as the Files view caps one. */
export const MAX_FILE_PATCH_CHARS = 1_500_000;
/** Header values are cut to this before decoding, so no header costs more than a line. */
const MAX_HEADER_CHARS = 2000;

export type PatchFileEntry = {
  /**
   * Unique within the file, and the same across re-reads while the file keeps
   * its place among those of its path: `<occurrence>:<path>`, the occurrence
   * counting from 1 across every commit.
   */
  key: string;
  file: ChangeFile;
  patch: FilePatch;
};

export type PatchFileCommit = {
  /** The commit's hash, from a `From <sha>` mail line or a `commit <sha>` line. */
  id: string | null;
  subject: string | null;
  /** The author as the header writes it, and the name alone, for display. */
  author: string | null;
  authorName: string | null;
  date: string | null;
  files: PatchFileEntry[];
};

export type PatchFile = {
  commits: PatchFileCommit[];
  /** Files drawn, and files past `MAX_PATCH_FILES` left out. */
  files: number;
  omitted: number;
  additions: number;
  deletions: number;
};

export type PatchRead = { ok: true; read: PatchFile } | { ok: false; reason: string };

/**
 * Where a commit starts: `git format-patch`'s mail separator with its fixed
 * date, `git log`'s commit line (its hash maybe abbreviated), or any mbox
 * `From ` line with a date, as b4 and lore write a series.
 */
const COMMIT_START =
  /^(?:From ([0-9a-f]{40}|[0-9a-f]{64}) Mon Sep 17 00:00:00 2001$|commit ([0-9a-f]{7,64})\b|From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$)/;
/** A header field: `Name: value`. */
const HEADER_FIELD = /^[A-Za-z][A-Za-z0-9-]*:/;
/** A mail header line, after an mbox `From ` line such as b4's and lore's `From git@z …`. */
const MAIL_FIELD = /^[A-Za-z-]+:/;
/** What follows `git log`'s commit line, so a message line reading "commit 1a2b…" is not one. */
const LOG_FIELD = /^(?:Merge|Author|AuthorDate|Commit|CommitDate|Date):/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const GIT_HEADER =
  /^(?:index |old mode |new mode |similarity index |dissimilarity index |new file mode |deleted file mode |rename from |rename to |copy from |copy to )/;

class Malformed extends Error {}

/** Why line `index` (zero-based) keeps the file from the diff view. */
function malformed(index: number, what: string): Malformed {
  return new Malformed(`Line ${index + 1} ${what}`);
}

export function readPatchFile(text: string): PatchRead {
  try {
    const reader = new Reader(splitLines(text));
    const read = reader.read();
    if (read.files + read.omitted === 0) return { ok: false, reason: "This file holds no diff." };
    // Whatever the reader concluded, the drawn copy must hold every hunk line of the file.
    const lost = checkDrawn(reader.lines, reader.claims, reader.sections, reader.drawn);
    if (lost !== null) return { ok: false, reason: lost };
    // A second, strict reading must find the same files, in the same commits, with the same counts.
    const disagreement = strictDisagreement(readStrict(text), reader.heads, reader.drawn);
    return disagreement === null ? { ok: true, read } : { ok: false, reason: disagreement };
  } catch (error) {
    if (error instanceof Malformed) return { ok: false, reason: `${error.message}.` };
    // Any other failure still says why the file shows as text.
    return { ok: false, reason: "The diff view couldn't read this file." };
  }
}

/** Why the strict reading disagrees with the reader's commits and files, or null when they match one for one. */
function strictDisagreement(
  strict: StrictRead,
  heads: readonly Head[],
  files: readonly DrawnFile[],
): string | null {
  if (!strict.strict)
    return `Line ${strict.line + 1} ${strict.why}, so the diff view can't be sure of it.`;
  if (strict.commits.length !== heads.length)
    return `A strict reading finds ${strict.commits.length} commits where the diff view finds ${heads.length}.`;
  for (const [index, head] of heads.entries())
    if (!sameCommit(head, strict.commits[index]!))
      return `Line ${head.start + 1} starts a commit that reads differently to a strict reading, so the diff view can't be sure of it.`;
  if (strict.files.length !== files.length)
    return `A strict reading finds ${strict.files.length} files where the diff view finds ${files.length}.`;
  for (const [index, file] of files.entries()) {
    const other = strict.files[index]!;
    if (!sameFile(file, other))
      return `Line ${other.start + 1} reads differently to a strict reading, so the diff view can't be sure of it.`;
  }
  return null;
}

/** A commit's start line and the header and message fields its card shows. */
type Head = { start: number } & Pick<Meta, "id" | "subject" | "author" | "date">;

function sameCommit(head: Head, strict: StrictCommit): boolean {
  return (
    head.start === strict.start &&
    sameField(head.id, strict.id) &&
    sameField(head.subject, strict.subject) &&
    sameField(head.author, strict.author) &&
    sameField(head.date, strict.date)
  );
}

/** Equal past surrounding whitespace; a value capped at MAX_HEADER_CHARS matches what it starts. */
function sameField(field: string | null, strict: string | null): boolean {
  if (field === null || strict === null) return field === strict;
  const [mine, theirs] = [field.trim(), strict.trim()];
  if (mine === theirs) return true;
  return (
    mine.endsWith("…") && theirs.length > MAX_HEADER_CHARS && theirs.startsWith(mine.slice(0, -1))
  );
}

function sameFile(file: DrawnFile, strict: StrictFile): boolean {
  return (
    file.start === strict.start &&
    file.commit === strict.commit &&
    file.kind === strict.kind &&
    file.additions === strict.additions &&
    file.deletions === strict.deletions &&
    file.path !== "" &&
    // The path is one of the record's names, or one past its a/ or b/ style first directory.
    strict.names.some(
      (name) => name === file.path || name.slice(name.indexOf("/") + 1) === file.path,
    )
  );
}

/**
 * Lines split on `\n` only. A CRLF file (its first line ends in `\r`) loses
 * one trailing `\r` per line; any other `\r` is the line's content.
 */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0]?.endsWith("\r"))
    for (let index = 0; index < lines.length; index++)
      if (lines[index]!.endsWith("\r")) lines[index] = lines[index]!.slice(0, -1);
  return lines;
}

type Draft = {
  start: number;
  end: number;
  git: boolean;
  /** Both sides of a `diff --git` line, and the prefixes it shows, or null for none. */
  gitOld: string | null;
  gitNew: string | null;
  srcPrefix: string | null;
  dstPrefix: string | null;
  /** The `---`/`+++` paths, once read. */
  oldName: string | null;
  newName: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  copied: boolean;
  added: boolean;
  deleted: boolean;
  binary: boolean;
  /** Whether a git file has any extended header line: a mode, an index, a rename. */
  described: boolean;
  hunks: number;
  /** Source lines the hunks hold, headers aside: each line, `\` notes included. */
  body: number;
  additions: number;
  deletions: number;
};

function newDraft(start: number, git: boolean): Draft {
  return {
    start,
    end: start + 1,
    git,
    gitOld: null,
    gitNew: null,
    srcPrefix: null,
    dstPrefix: null,
    oldName: null,
    newName: null,
    renameFrom: null,
    renameTo: null,
    copied: false,
    added: false,
    deleted: false,
    binary: false,
    described: false,
    hunks: 0,
    body: 0,
    additions: 0,
    deletions: 0,
  };
}

class Reader {
  readonly lines: string[];
  /** What each source line is to the reader: see `CLAIM`. */
  readonly claims: Uint8Array;
  /** Where each commit starts, and the MIME boundary its mail declares. */
  readonly sections: Section[] = [];
  /** Every file read, with what goes to the renderer. */
  readonly drawn: DrawnFile[] = [];
  /** Every commit header read, files or none, for the strict comparison. */
  readonly heads: Head[] = [];
  /** The current mail's declared MIME boundary, which may end its patch. */
  private boundary: string | null = null;
  private readonly commits: PatchFileCommit[] = [];
  private commit: PatchFileCommit = emptyCommit();
  private draft: Draft | null = null;
  /** Just past a hunk: a `+`, `-` or ` ` line here means the hunk held more than it counted. */
  private afterHunk = false;
  /** Past a hunk across blank lines and a mail signature only: a `+` or `-` line here is one it lost. */
  private trailing = false;
  /** How often each path has a card, for keys that hold across re-reads. */
  private readonly seen = new Map<string, number>();
  private index = 0;
  private kept = 0;
  private omitted = 0;
  private additions = 0;
  private deletions = 0;

  constructor(lines: string[]) {
    this.lines = lines;
    this.claims = new Uint8Array(lines.length);
  }

  private claim(from: number, to: number, what: number): void {
    this.claims.fill(what, from, Math.min(to, this.lines.length));
  }

  read(): PatchFile {
    while (this.index < this.lines.length) {
      if (commitStarts(this.lines, this.index)) this.startCommit();
      else this.step();
    }
    this.finishFile();
    this.pushCommit();
    return {
      commits: this.commits,
      files: this.kept,
      omitted: this.omitted,
      additions: this.additions,
      deletions: this.deletions,
    };
  }

  private startCommit(): void {
    this.finishFile();
    this.pushCommit();
    const header = readHeader(this.lines, this.index);
    this.commit = { ...header.meta, files: [] };
    this.boundary = header.boundary;
    this.sections.push({ start: this.index, boundary: header.boundary });
    const { id, subject, author, date } = header.meta;
    this.heads.push({ start: this.index, id, subject, author, date });
    this.index = header.next;
    this.afterHunk = false;
    this.trailing = false;
  }

  private pushCommit(): void {
    if (this.commit.files.length > 0) this.commits.push(this.commit);
  }

  private step(): void {
    const index = this.index;
    const line = this.lines[index]!;
    if (/^(?:diff --cc |diff --combined |@@@)/.test(line))
      throw malformed(index, "is part of a combined merge diff, which the diff view can't show");
    if (line.startsWith("diff --git ")) return this.startGit(index, line);
    if (line.startsWith("--- ") && this.lines[index + 1]?.startsWith("+++ "))
      return this.names(index);
    if (line.startsWith("@@")) return this.hunk(index, line);
    const draft = this.draft;
    if (draft && inGitHeader(draft) && readGitHeader(line, draft)) {
      this.index = line === "GIT binary patch" ? skipBinary(this.lines, index + 1) : index + 1;
      draft.end = this.index;
      this.claim(index, this.index, CLAIM.header);
      return;
    }
    const signature = this.checkPastHunk(index, line);
    // Anything else ends the file: a mail signature, a commit message, stray text.
    this.finishFile();
    this.trailing = (this.afterHunk || this.trailing) && (line === "" || signature);
    this.afterHunk = false;
    if (line.startsWith("Only in "))
      throw malformed(
        index,
        "names a file only one side has (Only in), which the diff view can't show",
      );
    const binary = plainBinary(line);
    if (binary === "unclear")
      throw malformed(index, "names binary files in a way the diff view can't split");
    if (binary) {
      // `diff -r` names a binary pair on one line, with no header of its own.
      const plain = newDraft(index, false);
      [plain.oldName, plain.newName] = binary;
      plain.binary = true;
      this.claim(index, index + 1, CLAIM.header);
      this.keep(plain);
    }
    this.index = index + 1;
  }

  /**
   * A hunk line where its hunk has ended: one it held past its counts, or one
   * it lost across a blank line or a signature. Returns whether the line is a
   * mail signature or MIME boundary.
   */
  private checkPastHunk(index: number, line: string): boolean {
    if (isMailTrailer(line, this.lines[index + 1], this.boundary)) return true;
    if (this.afterHunk && /^[+\- ]/.test(line))
      throw malformed(index, "continues a hunk past the lines its header counts");
    if (this.trailing && /^[+-]/.test(line))
      throw malformed(
        index,
        "follows a finished hunk as one of its lines, past what its header counts",
      );
    return false;
  }

  private startGit(index: number, line: string): void {
    this.finishFile();
    this.afterHunk = false;
    this.trailing = false;
    // An ambiguous line (a rename between spaced names) leaves the names to the lines below it.
    const sides = splitGitPaths(line.slice("diff --git ".length));
    const draft = newDraft(index, true);
    if (sides) [draft.gitOld, draft.gitNew, draft.srcPrefix, draft.dstPrefix] = sides;
    this.draft = draft;
    this.claim(index, index + 1, CLAIM.header);
    this.index = index + 1;
  }

  /** A `---`/`+++` pair: a git file's own before its first hunk, otherwise a new plain-diff file. */
  private names(index: number): void {
    const current = this.draft;
    const own = current && inGitHeader(current) && current.oldName === null;
    if (!own) this.finishFile();
    const draft = own ? current : newDraft(index, false);
    draft.oldName = headerName(this.lines[index]!.slice(4));
    draft.newName = headerName(this.lines[index + 1]!.slice(4));
    draft.end = index + 2;
    this.draft = draft;
    this.claim(index, index + 2, CLAIM.header);
    this.afterHunk = false;
    this.trailing = false;
    this.index = index + 2;
    const next = this.lines[index + 2] ?? "";
    if (next.startsWith("@@") && !HUNK.test(next))
      throw malformed(index + 2, "has a hunk header the diff view can't read");
    if (!HUNK.test(next)) throw malformed(index, "has a --- / +++ pair with no hunk after it");
  }

  private hunk(index: number, line: string): void {
    const header = HUNK.exec(line);
    if (!header) throw malformed(index, "has a hunk header the diff view can't read");
    const draft = this.draft;
    if (!draft || draft.oldName === null) throw malformed(index, "starts a hunk outside any file");
    this.index = readHunk(this.lines, index, header, draft);
    this.claim(index, index + 1, CLAIM.header);
    this.claim(index + 1, this.index, CLAIM.hunk);
    this.afterHunk = true;
  }

  private finishFile(): void {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    if (draft.git && draft.hunks === 0 && !draft.described && !draft.binary)
      throw malformed(draft.start, "has a diff --git line with no change after it");
    if (pathsOf(draft).every((path) => path === null))
      throw malformed(draft.start, "has a diff --git line that names no files");
    this.keep(draft);
  }

  /** What the guard and the strict comparison read of a file. */
  private facts(draft: Draft): Omit<DrawnFile, "entry"> {
    const [oldPath, newPath] = pathsOf(draft);
    return {
      start: draft.start,
      end: draft.end,
      body: draft.body,
      commit: this.sections.at(-1)?.start ?? -1,
      kind: draft.binary ? "binary" : draft.hunks > 0 ? "text" : "meta",
      path: (newPath === "/dev/null" ? oldPath : newPath) ?? oldPath ?? "",
      additions: draft.additions,
      deletions: draft.deletions,
    };
  }

  private keep(draft: Draft): void {
    if (pathsOf(draft).some((path) => path?.includes("\0")))
      throw malformed(draft.start, "names a file with a NUL character, which no file name holds");
    this.additions += draft.additions;
    this.deletions += draft.deletions;
    if (this.kept >= MAX_PATCH_FILES) {
      this.omitted++;
      this.drawn.push({ ...this.facts(draft), entry: null });
      return;
    }
    const entry = toEntry(draft, this.lines);
    const seen = (this.seen.get(entry.file.path) ?? 0) + 1;
    this.seen.set(entry.file.path, seen);
    entry.key = `${seen}:${entry.file.path}`;
    this.commit.files.push(entry);
    this.drawn.push({ ...this.facts(draft), entry });
    this.kept++;
  }
}

function emptyCommit(): PatchFileCommit {
  return { id: null, subject: null, author: null, authorName: null, date: null, files: [] };
}

/** Whether the line at `index` starts a commit. */
function commitStarts(lines: string[], index: number): boolean {
  const match = COMMIT_START.exec(lines[index]!);
  if (!match) return false;
  if (match[1] !== undefined) return true;
  return (match[2] === undefined ? MAIL_FIELD : LOG_FIELD).test(lines[index + 1] ?? "");
}

/** Whether a git file is still in its extended header, before its `---`/`+++` pair. */
const inGitHeader = (draft: Draft) => draft.git && draft.hunks === 0 && draft.oldName === null;

/** Reads a hunk whose header is at `start`, line for line against its counts; returns the line after it. */
function readHunk(lines: string[], start: number, header: RegExpExecArray, draft: Draft): number {
  const left = {
    old: header[1] === undefined ? 1 : Number(header[1]),
    next: header[2] === undefined ? 1 : Number(header[2]),
  };
  draft.hunks++;
  let index = start + 1;
  while (left.old > 0 || left.next > 0) {
    const line = lines[index];
    if (line === undefined || !countLine(line, left, draft))
      throw malformed(start, "starts a hunk whose lines don't match the counts in its header");
    // Drawn as the context line it stands for, so the drawn lines match the header's counts.
    if (line === "") lines[index] = " ";
    index++;
  }
  // "\ No newline at end of file" after the hunk's last line.
  while (lines[index]?.startsWith("\\")) index++;
  draft.body += index - start - 1;
  draft.end = index;
  return index;
}

/** Counts one hunk line against what the header has left; false when it does not fit. */
function countLine(line: string, left: { old: number; next: number }, draft: Draft): boolean {
  const mark = line[0];
  if (mark === "\\") return true;
  if (mark === "+") {
    draft.additions++;
    return left.next-- > 0;
  }
  if (mark === "-") {
    draft.deletions++;
    return left.old-- > 0;
  }
  // A blank line is context whose leading space an editor stripped.
  if (mark !== " " && line !== "") return false;
  return left.old-- > 0 && left.next-- > 0;
}

/** Consumes a git file's extended header line; false when the line is not one. */
function readGitHeader(line: string, draft: Draft): boolean {
  if ((line.startsWith(BINARY_HEAD) && line.endsWith(BINARY_TAIL)) || line === "GIT binary patch") {
    draft.binary = true;
    return true;
  }
  if (!GIT_HEADER.test(line)) return false;
  draft.described = true;
  if (line.startsWith("new file mode")) draft.added = true;
  else if (line.startsWith("deleted file mode")) draft.deleted = true;
  else if (line.startsWith("rename from ")) draft.renameFrom = quotedPath(line.slice(12));
  else if (line.startsWith("rename to ")) draft.renameTo = quotedPath(line.slice(10));
  else if (line.startsWith("copy from ")) {
    draft.renameFrom = quotedPath(line.slice(10));
    draft.copied = true;
  } else if (line.startsWith("copy to ")) draft.renameTo = quotedPath(line.slice(8));
  return true;
}

const BINARY_BLOCK = /^(?:literal|delta) \d+$/;
const BASE85_LINE = /^[A-Za-z][0-9A-Za-z!#$%&()*+;<=>?@^_`{|}~-]+$/;

/** A `GIT binary patch` body: `literal`/`delta` blocks of base85 lines, each ended by a blank line. */
function skipBinary(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (BINARY_BLOCK.test(line) || BASE85_LINE.test(line)) index++;
    else if (line === "" && BINARY_BLOCK.test(lines[index + 1] ?? "")) index++;
    else if (line === "") return index + 1;
    else break;
  }
  return index;
}

const BINARY_HEAD = "Binary files ";
const BINARY_TAIL = " differ";
const BINARY_JOIN = " and ";
/** Splits of a `Binary files` line tried at most: each costs a pass over the line. */
const MAX_BINARY_SPLITS = 16;

/**
 * `diff -r`'s `Binary files A and B differ`: both names, null for any other
 * line, or "unclear" when no single split names the pair. GNU diff
 * shell-quotes a name with a space or quote (`'a/my file'`, `"a/it's"`,
 * `'a/tab'$'\t''x'`); BSD diff writes names bare. Both sides of a `diff -r`
 * pair end in the same name, which picks the split when " and " repeats.
 */
function plainBinary(line: string): [string, string] | "unclear" | null {
  if (!line.startsWith(BINARY_HEAD) || !line.endsWith(BINARY_TAIL)) return null;
  const middle = line.slice(BINARY_HEAD.length, -BINARY_TAIL.length);
  const splits: [string, string][] = [];
  for (
    let at = middle.indexOf(BINARY_JOIN);
    at >= 0 && splits.length <= MAX_BINARY_SPLITS;
    at = middle.indexOf(BINARY_JOIN, at + 1)
  )
    splits.push([shellName(middle.slice(0, at)), shellName(middle.slice(at + BINARY_JOIN.length))]);
  const named = splits.filter(([old, next]) => old !== "" && next !== "");
  if (splits.length === 1) return named[0] ?? "unclear";
  const aligned = named.filter(([old, next]) => baseName(old) === baseName(next));
  return aligned.length === 1 ? aligned[0]! : "unclear";
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A name GNU diff shell-quoted, unquoted. GNU quotes a whole name, so only one
 * that opens with a quote is read as a shell word; a bare name, such as a
 * `--label`, is the text itself, backslashes and all.
 */
function shellName(text: string): string {
  return /^(?:['"]|\$')/.test(text) ? (shellWord(text) ?? text) : text;
}

const SHELL_ESCAPES: Readonly<Record<string, string>> = { ...QUOTED_ESCAPES, e: "\x1b", E: "\x1b" };

/** One shell word: '…', "…", $'…' and backslash escapes, joined; null for anything else. */
function shellWord(text: string): string | null {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return null;
      out += text.slice(index + 1, end);
      index = end + 1;
    } else if (char === '"') {
      const read = doubleQuoted(text, index + 1);
      if (!read) return null;
      out += read.value;
      index = read.next;
    } else if (char === "$" && text[index + 1] === "'") {
      const read = dollarQuoted(text, index + 2);
      if (!read) return null;
      out += read.value;
      index = read.next;
    } else if (char === "\\" && index + 1 < text.length) {
      out += text[index + 1];
      index += 2;
    } else if (char === " " || char === "\\") return null;
    else {
      out += char;
      index++;
    }
  }
  return out;
}

function doubleQuoted(text: string, start: number): { value: string; next: number } | null {
  let value = "";
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') return { value, next: index + 1 };
    if (char === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) value += text[++index];
    else value += char;
  }
  return null;
}

/** `$'…'`: C escapes, as bytes so a multi-byte character survives. */
function dollarQuoted(text: string, start: number): { value: string; next: number } | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const add = (chars: string) => {
    for (const byte of encoder.encode(chars)) bytes.push(byte);
  };
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (char === "'")
      return {
        value: new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(bytes)),
        next: index + 1,
      };
    if (char !== "\\") {
      add(char);
      continue;
    }
    const escaped = text[++index] ?? "";
    const octal = /^[0-7]{1,3}/.exec(text.slice(index, index + 3));
    const hex = escaped === "x" ? /^[0-9A-Fa-f]{1,2}/.exec(text.slice(index + 1, index + 3)) : null;
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      index += octal[0].length - 1;
    } else if (hex) {
      bytes.push(Number.parseInt(hex[0], 16));
      index += hex[0].length;
    } else add(SHELL_ESCAPES[escaped] ?? escaped);
  }
  return null;
}

const stripPrefix = (path: string | null, prefix: string | null) =>
  path !== null && prefix !== null && path !== "/dev/null" && path.startsWith(prefix)
    ? path.slice(prefix.length)
    : path;

/** The file's old and new paths, `/dev/null` for a side that does not exist. */
function pathsOf(draft: Draft): [string | null, string | null] {
  if (draft.git)
    return [
      draft.renameFrom ?? stripPrefix(draft.oldName ?? draft.gitOld, draft.srcPrefix),
      draft.renameTo ?? stripPrefix(draft.newName ?? draft.gitNew, draft.dstPrefix),
    ];
  // A plain diff names files as given; git's a/ b/ prefixes go only when each side carries its own.
  const { oldName, newName } = draft;
  const prefixed =
    (oldName === "/dev/null" || !!oldName?.startsWith("a/")) &&
    (newName === "/dev/null" || !!newName?.startsWith("b/")) &&
    !(oldName === "/dev/null" && newName === "/dev/null");
  return prefixed ? [stripPrefix(oldName, "a/"), stripPrefix(newName, "b/")] : [oldName, newName];
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
  const path = (kind === "deleted" ? oldPath : newPath) ?? oldPath ?? newPath!;
  const previousPath = kind === "renamed" || kind === "copied" ? draft.renameFrom : null;
  // No hunks (binary, a pure rename, a mode change) leaves nothing for Pierre: the card says why.
  let patch =
    draft.binary || draft.hunks === 0 ? "" : `${lines.slice(draft.start, draft.end).join("\n")}\n`;
  const truncated = patch.length > MAX_FILE_PATCH_CHARS;
  if (truncated) patch = "";
  return {
    key: "",
    file: {
      path,
      kind,
      previousPath,
      additions: draft.additions,
      deletions: draft.deletions,
      binary: draft.binary,
    },
    patch: { path, kind, previousPath, patch, truncated },
  };
}

/** Longest `diff --git` line whose two sides are worth aligning; a longer one leans on its `---`/`+++`. */
const MAX_ALIGN = 4096;

/**
 * Both sides of a `diff --git` line and their prefixes: `a/`/`b/`, the
 * mnemonic `c/`/`w/`/`i/`/`o/`, `--src-prefix`/`--dst-prefix`, or none with
 * `--no-prefix`. Unquoted sides may hold spaces, so the split is the one
 * where both sides name the same file once their first segments go; a
 * rename names itself on its own lines. Null when no split works.
 */
function splitGitPaths(
  rest: string,
): [string | null, string | null, string | null, string | null] | null {
  const quoted = splitQuoted(rest);
  const sides = quoted ?? alignSides(rest);
  if (!sides) return null;
  const [old, next] = sides;
  if (old === next) return [old, next, null, null];
  const oldSlash = old.indexOf("/");
  const nextSlash = next.indexOf("/");
  if (oldSlash > 0 && nextSlash > 0 && old.slice(oldSlash + 1) === next.slice(nextSlash + 1))
    return [old, next, old.slice(0, oldSlash + 1), next.slice(0, nextSlash + 1)];
  // A rename with git's default prefixes.
  if (old.startsWith("a/") && next.startsWith("b/")) return [old, next, "a/", "b/"];
  return [old, next, null, null];
}

/** Sides when either is C-quoted. */
function splitQuoted(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    if (end < 0 || rest[end + 1] !== " ") return null;
    return [quotedPath(rest.slice(0, end + 1)), quotedPath(rest.slice(end + 2))];
  }
  if (rest.endsWith('"')) {
    const open = rest.lastIndexOf(' "');
    if (open > 0) return [rest.slice(0, open), quotedPath(rest.slice(open + 1))];
  }
  return null;
}

/** Unquoted sides split at the space where they name the same file, or at ` b/` for a rename. */
function alignSides(rest: string): [string, string] | null {
  if (rest.length <= MAX_ALIGN)
    for (let space = rest.indexOf(" "); space > 0; space = rest.indexOf(" ", space + 1)) {
      const old = rest.slice(0, space);
      const next = rest.slice(space + 1);
      if (old === next) return [old, next];
      const oldSlash = old.indexOf("/");
      const nextSlash = next.indexOf("/");
      if (
        oldSlash > 0 &&
        nextSlash > 0 &&
        old.length - oldSlash === next.length - nextSlash &&
        old.slice(oldSlash) === next.slice(nextSlash)
      )
        return [old, next];
    }
  const split = rest.indexOf(" b/");
  return split > 0 ? [rest.slice(0, split), rest.slice(split + 1)] : null;
}

/** A `---`/`+++` path, without `diff -u`'s timestamp after a tab. */
function headerName(value: string): string {
  if (value.startsWith('"')) {
    const end = closingQuote(value);
    if (end > 0) return quotedPath(value.slice(0, end + 1));
  }
  const tab = value.indexOf("\t");
  return (tab < 0 ? value : value.slice(0, tab)).trimEnd();
}

function closingQuote(text: string): number {
  for (let index = 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index;
  }
  return -1;
}

// ── Commit headers ─────────────────────────────────────────────────────

type Meta = Omit<PatchFileCommit, "files">;

/** The mail or `git log` header at `start`; `next` is where its files may begin. */
function readHeader(
  lines: string[],
  start: number,
): { meta: Meta; next: number; boundary: string | null } {
  const meta: Meta = emptyCommit();
  const first = COMMIT_START.exec(lines[start]!)!;
  meta.id = first[1] ?? first[2] ?? null;
  if (first[2] !== undefined) {
    const next = readLogHeader(lines, start + 1, meta);
    meta.authorName = nameOf(meta.author);
    return { meta, next, boundary: null };
  }
  const mail = readMailHeader(lines, start + 1, meta);
  meta.authorName = nameOf(meta.author);
  return { meta, next: skipMailBody(lines, mail.next), boundary: mail.boundary };
}

/** Mail headers, folded lines joined, up to the blank line before the message. */
function readMailHeader(
  lines: string[],
  start: number,
  meta: Meta,
): { next: number; boundary: string | null } {
  const fields = new Map<string, string>();
  let last: string | null = null;
  let index = start;
  for (; index < lines.length && lines[index] !== ""; index++) {
    const line = lines[index]!;
    // A line that is no field and no fold ends the header, as a diff with no blank before it does.
    if (!HEADER_FIELD.test(line) && !/^[ \t]/.test(line)) break;
    if (/^[ \t]/.test(line) && last !== null) {
      fields.set(last, cap(`${fields.get(last)} ${line.trim()}`));
      continue;
    }
    const colon = line.indexOf(":");
    last = colon > 0 && /^[A-Za-z-]+$/.test(line.slice(0, colon)) ? line.slice(0, colon) : null;
    if (last !== null) fields.set(last, cap(line.slice(colon + 1).trim()));
  }
  const from = fields.get("From");
  const subject = fields.get("Subject");
  meta.author = from === undefined ? null : decodeWords(from);
  meta.date = fields.get("Date") ?? null;
  meta.subject =
    subject === undefined ? null : decodeWords(subject).replace(/^\[[^\]]*\]\s*/, "") || null;
  const multipart = /^multipart\/[^;]*;.*\bboundary="?([^";\s]+)"?/i.exec(
    fields.get("Content-Type") ?? "",
  );
  return { next: index, boundary: multipart?.[1] ?? null };
}

/**
 * The commit message and diffstat: format-patch ends the message at a `---`
 * line. A `---`/`+++` pair inside the message is the author's text, not a file.
 */
function skipMailBody(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === "---") return index + 1;
    if (line.startsWith("diff --git ") || commitStarts(lines, index)) return index;
  }
  return lines.length;
}

/** `git log`/`git show`: Author and Date, then the message indented four spaces. */
function readLogHeader(lines: string[], start: number, meta: Meta): number {
  let index = start;
  // Fields up to a blank line, or to the first line that is no field, such as a diff with no blank before it.
  for (; index < lines.length && HEADER_FIELD.test(lines[index]!); index++) {
    const field = /^(Author|Date|AuthorDate):\s*(.*)$/.exec(cap(lines[index]!));
    if (field?.[1] === "Author") meta.author = field[2]!;
    else if (field) meta.date = field[2]!;
  }
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === "") continue;
    if (!line.startsWith("    ")) break;
    meta.subject ??= cap(line.trim());
  }
  return index;
}

const cap = (value: string) =>
  value.length > MAX_HEADER_CHARS ? `${value.slice(0, MAX_HEADER_CHARS)}…` : value;

/** `Name <email>` as the name alone. */
function nameOf(author: string | null): string | null {
  if (author === null) return null;
  const open = author.lastIndexOf("<");
  return (open > 0 && author.endsWith(">") ? author.slice(0, open).trimEnd() : author) || author;
}

const ENCODED_WORD = /=\?([^?\s]+)\?([qQbB])\?([^?\s]*)\?=/g;

/**
 * RFC 2047 encoded words (`=?UTF-8?q?...?=`), as format-patch writes a
 * non-ASCII name or subject. Words separated only by whitespace join, and
 * their bytes decode together, so a character split across a fold survives.
 */
function decodeWords(value: string): string {
  let out = "";
  let run: { charset: string; bytes: number[] } | null = null;
  let at = 0;
  const flush = () => {
    if (!run) return;
    try {
      out += new TextDecoder(run.charset).decode(Uint8Array.from(run.bytes));
    } catch {
      out += String.fromCharCode(...run.bytes);
    }
    run = null;
  };
  for (const match of value.matchAll(ENCODED_WORD)) {
    const gap = value.slice(at, match.index);
    if (!run || gap.trim() !== "" || run.charset !== match[1]!.toLowerCase()) {
      flush();
      out += gap;
    }
    run ??= { charset: match[1]!.toLowerCase(), bytes: [] };
    run.bytes.push(...wordBytes(match[2]!, match[3]!));
    at = match.index + match[0].length;
  }
  flush();
  return out + value.slice(at);
}

function wordBytes(encoding: string, data: string): number[] {
  if (encoding.toLowerCase() === "b") {
    try {
      return Array.from(atob(data), (char) => char.charCodeAt(0));
    } catch {
      return [];
    }
  }
  const bytes: number[] = [];
  for (let index = 0; index < data.length; index++) {
    const char = data[index]!;
    const hex = char === "=" ? data.slice(index + 1, index + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(char === "_" ? 0x20 : char.charCodeAt(0));
  }
  return bytes;
}
