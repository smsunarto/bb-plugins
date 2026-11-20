/**
 * The inputs the diff view draws, as a closed grammar. Its first line picks
 * one of four forms, and every line after it must be part of that form:
 *
 * - `git diff`: `diff --git` sections with git's extended headers, a
 *   `---`/`+++` pair and hunks, or a binary record;
 * - `git log -p` and `git show`: git's default commit header (`commit`,
 *   Author, Date, the message indented four spaces), then its sections;
 * - `git format-patch`: mails from a `From <sha>` line with From, Date and
 *   Subject, plain 7bit or 8bit text, the message, a `---` line, a
 *   diffstat, then sections and git's signature;
 * - `diff -u` of one or more files, each `---`/`+++` pair maybe after
 *   `diff -r`'s command line.
 *
 * Anything else — another log format, a submodule log, a MIME-encoded or
 * multipart mail, a mail whose body overrides its author, `Only in` or a
 * binary record between `diff -u` files, a hunk whose counts run into the
 * next file's header, a `\` line git doesn't write, a deleted file whose
 * `+++` names a file, a commit with no files — is not drawn: the file shows
 * as text with the reason. The reader and the strict reading then check
 * what this lets through.
 */

/** Not allowed: `line` -1 when the text holds nothing that reads as a diff at all. */
export type Allowed = { ok: true } | { ok: false; line: number; why: string };

/** Lines that only a diff holds. */
const DIFF_LINE = /^(?:diff |--- |\+\+\+ |@@ |Binary files |GIT binary patch$|Index: |Only in )/;

class NotAllowed extends Error {
  readonly line: number;
  constructor(line: number, why: string) {
    super(why);
    this.line = line;
  }
}

const MAIL_START = /^From [0-9a-f]{40}(?:[0-9a-f]{24})? Mon Sep 17 00:00:00 2001$/;
const LOG_START = /^commit [0-9a-f]{7,64}(?: \(.+\))?$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const NO_NEWLINE = "\\ No newline at end of file";
const MAIL_FIELD = /^([A-Za-z][A-Za-z0-9-]*):(.*)$/;
/** A diff -r command line before a file's `---`/`+++` pair. */
const DIFF_COMMAND = /^diff -(?!-git )\S+ \S/;
/** Lines a commit message may not hold before its `---` line: they read as part of a patch. */
const PATCH_LIKE =
  /^(?:diff (?:--git |-\S)|@@ -\d|Only in |Binary files |Index: |GIT binary patch$|Submodule |Common subdirectories: )/;

const SUBMODULE = "is a submodule log, which the diff view doesn't draw";

export function checkAllowed(text: string): Allowed {
  try {
    new Gate(splitSource(text)).run();
    return { ok: true };
  } catch (error) {
    if (error instanceof NotAllowed) return { ok: false, line: error.line, why: error.message };
    throw error;
  }
}

function splitSource(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0]?.endsWith("\r"))
    for (let index = 0; index < lines.length; index++)
      if (lines[index]!.endsWith("\r")) lines[index] = lines[index]!.slice(0, -1);
  return lines;
}

/** What a section's headers say the file is. */
type Header = { added: boolean; deleted: boolean };

class Gate {
  private readonly lines: string[];
  private at = 0;

  constructor(lines: string[]) {
    this.lines = lines;
  }

  /** Whether only blank lines remain: no form minds them at the end, past what its counts read. */
  private atEnd(): boolean {
    for (let at = this.at; at < this.lines.length; at++) if (this.lines[at] !== "") return false;
    return true;
  }

  /** A line where only a file may start. */
  private stray(): never {
    if (this.now()?.startsWith("Binary files "))
      this.fail("is a binary record outside a git diff, which the diff view doesn't draw");
    if (this.now()?.startsWith("Submodule ")) this.fail(SUBMODULE);
    if (/^[-+ ]/.test(this.now() ?? ""))
      this.fail("continues a hunk past the lines its header counts");
    this.fail("isn't part of any file the diff view knows");
  }

  /** Whether a file header starts here: a `---` line, a `+++` line, and a hunk header. */
  private startsFileHeader(): boolean {
    return (
      this.lines[this.at]!.startsWith("--- ") &&
      (this.lines[this.at + 1] ?? "").startsWith("+++ ") &&
      (this.lines[this.at + 2] ?? "").startsWith("@@ ")
    );
  }

  /** The line the gate is at; a method, so each read sees where the gate has moved. */
  private now(): string | undefined {
    return this.lines[this.at];
  }

  private fail(why: string, at = this.at): never {
    throw new NotAllowed(at, why);
  }

  run(): void {
    while (this.now()?.trim() === "") this.at++;
    const first = this.now();
    if (first === undefined || !this.lines.some((line) => DIFF_LINE.test(line)))
      this.fail("holds no diff", -1);
    if (MAIL_START.test(first)) while (!this.atEnd()) this.readMail();
    else if (LOG_START.test(first)) while (!this.atEnd()) this.readCommit();
    else if (first.startsWith("diff --git ")) this.readGitSections(() => false);
    else if (first.startsWith("--- ") || DIFF_COMMAND.test(first)) this.readPlainFiles();
    else if (first.startsWith("Only in "))
      this.fail("names a file only one side has (Only in), which the diff view can't show");
    else if (first.startsWith("Binary files "))
      this.fail("is a binary record outside a git diff, which the diff view doesn't draw");
    else if (first.startsWith("@@")) this.fail("starts a hunk outside any file");
    else if (first.startsWith("Submodule ")) this.fail(SUBMODULE);
    else
      this.fail(
        "isn't the start of a git diff, git log, git format-patch or diff -u, the forms the diff view draws",
      );
  }

  // ── git log -p / git show ───────────────────────────────────────────

  private readCommit(): void {
    const start = this.at;
    if (!LOG_START.test(this.now()!)) this.fail("isn't git log's commit line");
    this.at++;
    if (this.now()?.startsWith("Merge: ")) this.at++;
    for (const field of ["Author: ", "Date: "]) {
      if (!this.now()?.startsWith(field))
        this.fail(`isn't git log's default ${field.slice(0, -2)} line, which the diff view needs`);
      this.at++;
    }
    if (this.now() !== "") this.fail("isn't part of git log's default commit header");
    this.at++;
    while (this.now()?.startsWith("    ")) this.at++;
    if (this.now() === "") this.at++;
    if (/^diff --(?:cc|combined) /.test(this.now() ?? ""))
      this.fail("is part of a combined merge diff, which the diff view can't show");
    if (!this.now()?.startsWith("diff --git "))
      this.fail("starts a commit with no files, which the diff view can't show", start);
    // A commit ends at a blank line before the next commit line.
    this.readGitSections(() => this.now() === "" && LOG_START.test(this.lines[this.at + 1] ?? ""));
    if (this.now() === "") this.at++;
  }

  // ── git format-patch ────────────────────────────────────────────────

  private readMail(): void {
    const start = this.at;
    if (!MAIL_START.test(this.now()!))
      this.fail("isn't the From line that starts a format-patch mail");
    this.at++;
    this.readMailHeader(start);
    this.readMessage(start);
    if (!this.now()?.startsWith("diff --git "))
      this.fail("starts a mail with no files, which the diff view can't show", start);
    this.readGitSections(
      () =>
        this.now() === "-- " ||
        this.now() === "--" ||
        this.now() === "" ||
        this.now()?.startsWith("base-commit: ") === true,
    );
    this.readMailEnd();
  }

  private readMailHeader(start: number): void {
    const fields = new Set<string>();
    while (this.now() !== undefined && this.now() !== "") {
      const field = MAIL_FIELD.exec(this.now() ?? "");
      if (field) {
        const name = field[1]!.toLowerCase();
        const value = field[2]!.trim();
        fields.add(name);
        if (name === "content-transfer-encoding" && !/^(?:7bit|8bit)$/i.test(value))
          this.fail(`encodes its text as ${value}, which the diff view doesn't decode`);
        if (name === "content-type" && !/^text\/plain\b/i.test(value))
          this.fail("is a MIME mail with parts, which the diff view doesn't read");
      } else if (!/^[ \t]+\S/.test(this.now() ?? "")) this.fail("isn't part of the mail's header");
      this.at++;
    }
    for (const name of ["from", "date", "subject"])
      if (!fields.has(name))
        this.fail(`starts a mail with no ${name[0]!.toUpperCase()}${name.slice(1)} line`, start);
    if (this.now() === undefined) this.fail("ends the mail before its message", start);
    this.at++;
  }

  /** The message up to its `---` line, then the diffstat up to the first file. */
  private readMessage(start: number): void {
    let first = this.at;
    while (this.lines[first] === "") first++;
    if (/^(?:from|date|subject):/i.test(this.lines[first] ?? ""))
      this.fail(
        "overrides the mail's header in its body, which the diff view doesn't follow",
        first,
      );
    while (this.now() !== "---") {
      const line = this.now();
      // A message that ends with no --- line and no patch-like line before it holds no files.
      if (line === undefined || MAIL_START.test(line) || line === "-- ")
        this.fail("starts a mail with no files, which the diff view can't show", start);
      if (PATCH_LIKE.test(line) || this.startsFileHeader())
        this.fail("reads as part of a patch inside the mail's message, before its --- line");
      this.at++;
    }
    this.at++;
    // The diffstat: indented lines, and blank lines.
    while (this.now() !== undefined && (this.now() === "" || this.now()!.startsWith(" ")))
      this.at++;
  }

  /** After a mail's last file: `base-commit:` lines, git's signature, then blank lines. */
  private readMailEnd(): void {
    while (
      this.now() === "" ||
      /^(?:base-commit|prerequisite-patch-id): \S+$/.test(this.now() ?? "")
    )
      this.at++;
    // git's signature; an editor may have trimmed its trailing space.
    if (this.now() === "-- " || this.now() === "--") {
      this.at++;
      if (this.now() === undefined || this.now() === "")
        this.fail("ends git's signature without its version line");
      this.at++;
    }
    while (this.now() === "") this.at++;
    if (this.now() !== undefined && !MAIL_START.test(this.now()!))
      this.fail("follows a mail's last file but starts no mail");
  }

  // ── diff --git sections ─────────────────────────────────────────────

  /** Sections up to the end, or to where `ends` says the form's own lines resume. */
  private readGitSections(ends: () => boolean): void {
    while (!this.atEnd() && !ends()) {
      if (!this.now()!.startsWith("diff --git ")) this.stray();
      this.readGitSection();
    }
  }

  private readGitSection(): void {
    const start = this.at;
    this.at++;
    const { header, described } = this.readExtendedHeader(start);
    const line = this.now() ?? "";
    if (/^Binary files .+ differ$/.test(line)) this.at++;
    else if (line === "GIT binary patch") this.readBinaryBody();
    else if (line.startsWith("--- ")) this.readFile(header);
    else if (!described) this.fail("has a diff --git line with no change after it", start);
  }

  /** git's extended header lines: what they say of the file, and whether they say anything but its index. */
  private readExtendedHeader(start: number): { header: Header; described: boolean } {
    const header = { added: false, deleted: false };
    let described = false;
    let renaming: "rename" | "copy" | null = null;
    for (;;) {
      const line = this.now() ?? "";
      if (/^new file mode [0-7]{6}$/.test(line)) header.added = true;
      else if (/^deleted file mode [0-7]{6}$/.test(line)) header.deleted = true;
      else if (/^(?:rename|copy) from /.test(line))
        renaming = line.startsWith("rename") ? "rename" : "copy";
      else if (/^(?:rename|copy) to /.test(line)) {
        if (renaming === null || !line.startsWith(renaming))
          this.fail(`has a ${line.split(" ")[0]} to line with no from line`);
        renaming = null;
      } else if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(line)) {
        this.at++;
        continue;
      } else if (!/^(?:(?:old|new) mode [0-7]{6}|(?:dis)?similarity index \d+%)$/.test(line)) break;
      described = true;
      this.at++;
    }
    if (renaming !== null) this.fail(`has a ${renaming} from line with no to line`);
    if (header.added && header.deleted) this.fail("says its file is both new and deleted", start);
    return { header, described };
  }

  /** `literal`/`delta` blocks of base85 lines, each closed by a blank line: the forward one, then maybe the reverse. */
  private readBinaryBody(): void {
    this.at++;
    for (let block = 0; block < 2; block++) {
      if (!/^(?:literal|delta) \d+$/.test(this.now() ?? "")) {
        if (block === 0) this.fail("starts a binary patch without its literal or delta line");
        return;
      }
      this.at++;
      while (/^[A-Za-z][!-~]*$/.test(this.now() ?? "")) this.at++;
      if (this.now() !== "") this.fail("breaks off a binary patch");
      this.at++;
    }
  }

  // ── diff -u ─────────────────────────────────────────────────────────

  private readPlainFiles(): void {
    while (!this.atEnd()) {
      if (DIFF_COMMAND.test(this.now()!)) this.at++;
      if (this.now()?.startsWith("Only in "))
        this.fail("names a file only one side has (Only in), which the diff view can't show");
      if (this.now()?.startsWith("Binary files "))
        this.fail("is a binary record between diff -u files, which the diff view doesn't draw");
      if (!this.now()?.startsWith("--- ")) this.stray();
      this.readFile(null);
    }
  }

  // ── A file's `---`/`+++` pair and hunks ─────────────────────────────

  /** `header` is a git section's; null for diff -u, where /dev/null alone marks a new or deleted file. */
  private readFile(header: Header | null): void {
    const start = this.at;
    const next = this.lines[this.at + 1];
    if (!next?.startsWith("+++ ")) this.fail("starts a file header without its +++ line");
    const sides = { added: isDevNull(this.now()!.slice(4)), deleted: isDevNull(next.slice(4)) };
    if (sides.added && sides.deleted) this.fail("names /dev/null on both sides");
    if (header) this.checkSides(header, sides, start);
    this.at += 2;
    if (!HUNK.test(this.now() ?? "")) this.fail("has a file header with no hunk after it", start);
    this.readHunks(sides);
  }

  /**
   * git's new and deleted file mode lines need /dev/null on their side of the
   * `---`/`+++` pair. /dev/null alone, as hand-written and generated diffs
   * leave it, marks the file new or deleted by itself.
   */
  private checkSides(header: Header, sides: Header, start: number): void {
    if (header.added && !sides.added) this.fail("says its file is new but --- names a file");
    if (header.deleted && !sides.deleted)
      this.fail("says its file is deleted but +++ names a file", start + 1);
  }

  private readHunks({ added, deleted }: Header): void {
    let last: { old: number; next: number } | null = null;
    while (this.now()?.startsWith("@@")) {
      const hunk = HUNK.exec(this.now()!);
      if (!hunk) this.fail("has a hunk header the diff view can't read");
      const [oldStart, nextStart] = [Number(hunk[1]), Number(hunk[3])];
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const nextCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      if (added && oldStart + oldCount !== 0) this.fail("adds a file but its hunk reads old lines");
      if (deleted && nextStart + nextCount !== 0)
        this.fail("deletes a file but its hunk writes new lines");
      if (last && (oldStart < last.old || nextStart < last.next))
        this.fail("starts a hunk inside or before the hunk above it");
      last = { old: oldStart + oldCount, next: nextStart + nextCount };
      this.readHunkBody(oldCount, nextCount);
    }
  }

  private readHunkBody(oldCount: number, nextCount: number): void {
    const header = this.at++;
    let old = oldCount;
    let next = nextCount;
    while (old > 0 || next > 0) {
      const line = this.now();
      if (line === undefined) this.fail("ends before the lines its hunk header counts", header);
      if (line === "" || line.startsWith(" ")) {
        old--;
        next--;
      } else if (line.startsWith("-")) {
        // Counts that run into the next file's header would draw that file's lines as this one's.
        if (this.startsFileHeader())
          this.fail("is a hunk whose counts run into the next file's --- / +++ header", header);
        old--;
      } else if (line.startsWith("+")) next--;
      else if (line !== NO_NEWLINE)
        this.fail(
          line.startsWith("\\") ? "is a \\ line git doesn't write" : "breaks off the hunk above it",
        );
      if (old < 0 || next < 0) this.fail("holds more lines than its hunk header counts", header);
      this.at++;
    }
    if (this.now() === NO_NEWLINE) this.at++;
    else if (this.now()?.startsWith("\\")) this.fail("is a \\ line git doesn't write");
  }
}

/** `/dev/null`, maybe followed by diff's tab and timestamp. */
function isDevNull(name: string): boolean {
  return name === "/dev/null" || name.startsWith("/dev/null\t");
}
