/**
 * A second, strict reading of a patch file, written apart from the reader in
 * patch-file.ts and sharing none of its code. It walks the source once and
 * accounts for every line: commit, mail and log headers and their messages;
 * `diff --git`, `---`/`+++`, `Binary files` and `Only in` records; hunk
 * headers and their lines, counted exactly; and mail trailers. It lists the
 * files it finds. A line it can't place, a count that doesn't hold, or a
 * boundary it can't be sure of (a hunk whose range runs back over the one
 * before it) makes the read not strict.
 *
 * The opener draws only when this pass is strict and its list matches the
 * reader's file by file; anything else shows as text.
 */

export type StrictFile = {
  /** Line where the file's commit starts, or -1 for a file before any commit. */
  commit: number;
  /** Line where the file's record starts. */
  start: number;
  kind: "text" | "binary" | "meta" | "only-in";
  /** What the record's headers say happened to the file. */
  change: "added" | "deleted" | "modified" | "renamed" | "copied";
  /**
   * Every name the file's record could give, unquoted: each side whole, and
   * each way a bare `diff --git` or `Binary files` line splits. Its path is
   * one of them, or one of them past its first directory.
   */
  names: string[];
  additions: number;
  deletions: number;
};

/** A commit's start line and what its header and message say. */
export type StrictCommit = {
  start: number;
  id: string | null;
  subject: string | null;
  author: string | null;
  date: string | null;
};

export type StrictRead =
  | { strict: true; commits: StrictCommit[]; files: StrictFile[] }
  | { strict: false; line: number; why: string };

class NotStrict extends Error {
  readonly line: number;
  constructor(line: number, why: string) {
    super(why);
    this.line = line;
  }
}

/** Where the walk is: what a line that starts no record may be there. */
type Region =
  /** Before a commit's first file: its message, diffstat, or a preamble. Free text. */
  | "free"
  /** A mail's message, before its `---`: free text, and only `diff --git` starts a file. */
  | "mail-body"
  /** Between and after files: blank lines and the few lines tools print there. */
  | "between"
  /** After a signature: in a mail, anything up to the next mail, as git am reads it; elsewhere, git's version line and blank lines. */
  | "signature";

const COMMIT_MAIL = /^From [0-9a-f]{40,64} Mon Sep 17 00:00:00 2001$/;
const COMMIT_MBOX = /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
const COMMIT_LOG = /^commit [0-9a-f]{7,64}(?: |$)/;
const FIELD = /^[A-Za-z][A-Za-z0-9-]*:/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_FIELD =
  /^(?:old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |index )/;
/** Lines diff tools print between files that hold no change. */
const BETWEEN =
  /^(?:$|diff (?!--git )|Index: |={20,}$|Common subdirectories: |base-commit: |prerequisite-patch-id: )/;

export function readStrict(text: string): StrictRead {
  try {
    const walk = new Walk(lines(text));
    walk.run();
    return { strict: true, commits: walk.commits, files: walk.files };
  } catch (error) {
    if (error instanceof NotStrict) return { strict: false, line: error.line, why: error.message };
    throw error;
  }
}

function lines(text: string): string[] {
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  if (out.length > 0 && out[0]!.endsWith("\r"))
    for (let index = 0; index < out.length; index++)
      if (out[index]!.endsWith("\r")) out[index] = out[index]!.slice(0, -1);
  return out;
}

class Walk {
  private readonly source: string[];
  readonly files: StrictFile[] = [];
  readonly commits: StrictCommit[] = [];
  private at = 0;
  private region: Region = "free";
  private commit = -1;
  private boundary: string | null = null;
  /** Whether the current commit is a mail. */
  private mail = false;

  constructor(source: string[]) {
    this.source = source;
  }

  run(): void {
    while (this.at < this.source.length) {
      const line = this.source[this.at]!;
      if (this.startsCommit()) this.readCommit();
      // Past a signature only a new commit starts anything: a file there has an unsure boundary.
      else if (this.region === "signature") this.otherLine(line);
      else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined "))
        throw new NotStrict(this.at, "is part of a combined merge diff");
      else if (line.startsWith("diff --git ")) this.readGitFile();
      else if (this.region !== "mail-body" && this.startsPlainFile()) this.readPlainFile();
      else if (this.region !== "mail-body" && line.startsWith("Binary files "))
        this.record("binary", binaryNames(line, this.at));
      else if (this.region !== "mail-body" && line.startsWith("Only in "))
        this.record("only-in", [line.slice("Only in ".length)]);
      else this.otherLine(line);
    }
  }

  private startsCommit(): boolean {
    const line = this.source[this.at]!;
    const next = this.source[this.at + 1] ?? "";
    if (COMMIT_MAIL.test(line)) return true;
    if (COMMIT_MBOX.test(line)) return FIELD.test(next);
    return COMMIT_LOG.test(line) && FIELD.test(next);
  }

  private startsPlainFile(): boolean {
    return (
      this.source[this.at]!.startsWith("--- ") &&
      (this.source[this.at + 1] ?? "").startsWith("+++ ") &&
      (this.source[this.at + 2] ?? "").startsWith("@@")
    );
  }

  /** A line that starts no record: allowed by the region it falls in, or not strict. */
  private otherLine(line: string): void {
    const at = this.at++;
    switch (this.region) {
      case "free":
        return;
      case "mail-body":
        if (line === "---") this.region = "free";
        return;
      case "signature":
        return this.signatureLine(line, at);
      case "between":
        if (line === "-- " || (line === "--" && /^\d+(?:\.\d+)+/.test(this.source[at + 1] ?? ""))) {
          this.region = "signature";
          return;
        }
        if (
          this.boundary !== null &&
          (line === `--${this.boundary}` || line === `--${this.boundary}--`)
        )
          return;
        if (BETWEEN.test(line)) return;
        throw new NotStrict(at, "isn't part of any file, commit or mail the diff view knows");
    }
  }

  /** A line past a signature: a mail's own text, or a log's version line. */
  private signatureLine(line: string, at: number): void {
    if (
      line.startsWith("diff --git ") ||
      (line.startsWith("--- ") && this.source[at + 1]?.startsWith("+++ "))
    )
      throw new NotStrict(at, "starts a file after the mail's signature");
    if (this.mail || line === "" || /^\d+(?:\.\d+)+/.test(line)) return;
    throw new NotStrict(at, "follows a mail signature but isn't a version line");
  }

  private readCommit(): void {
    const first = this.source[this.at]!;
    const mail = !first.startsWith("commit ");
    this.commit = this.at;
    this.mail = mail;
    this.at++;
    const fields = this.readFields(mail);
    const commit = mail ? mailCommit(fields) : logCommit(fields, this.messageStart());
    commit.start = this.commit;
    commit.id = COMMIT_MAIL.test(first) || !mail ? (first.split(" ")[1] ?? null) : null;
    this.commits.push(commit);
    this.boundary = mail ? boundaryOf(fields.get("Content-Type") ?? "") : null;
    this.region = mail ? "mail-body" : "free";
  }

  /** Header fields, a mail's folded lines joined, up to a blank line or anything else. */
  private readFields(mail: boolean): Map<string, string> {
    const fields = new Map<string, string>();
    let last: string | null = null;
    while (this.at < this.source.length) {
      const line = this.source[this.at]!;
      if (FIELD.test(line)) {
        const colon = line.indexOf(":");
        last = line.slice(0, colon);
        fields.set(last, line.slice(colon + 1).trim());
      } else if (mail && /^[ \t]/.test(line) && line.trim() !== "") {
        if (last !== null) fields.set(last, `${fields.get(last)} ${line.trim()}`);
      } else break;
      this.at++;
    }
    return fields;
  }

  /** A log message's first line, indented four spaces after any blank lines; null when there is none. */
  private messageStart(): string | null {
    let at = this.at;
    while (this.source[at] === "") at++;
    const line = this.source[at];
    return line?.startsWith("    ") ? line.trim() : null;
  }

  private record(kind: StrictFile["kind"], names: string[]): void {
    this.files.push({
      commit: this.commit,
      start: this.at,
      kind,
      names,
      change: "modified",
      additions: 0,
      deletions: 0,
    });
    this.at++;
    this.region = "between";
  }

  private readGitFile(): void {
    const file: StrictFile = {
      commit: this.commit,
      start: this.at,
      kind: "meta",
      names: gitLineNames(this.source[this.at]!.slice("diff --git ".length)),
      change: "modified",
      additions: 0,
      deletions: 0,
    };
    this.at++;
    let described = false;
    while (this.at < this.source.length) {
      const line = this.source[this.at]!;
      if (GIT_FIELD.test(line)) {
        described = true;
        const renamed = /^(?:rename|copy) to (.*)$/.exec(line);
        if (renamed) file.names.push(unquote(renamed[1]!, this.at));
        file.change = changeOf(line) ?? file.change;
        this.at++;
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        file.kind = "binary";
        this.at++;
      } else if (line === "GIT binary patch") {
        file.kind = "binary";
        this.skipBinaryBody();
      } else break;
    }
    if (this.source[this.at]?.startsWith("--- ")) {
      if (file.kind === "binary")
        throw new NotStrict(this.at, "follows a binary file with a text header");
      this.readNames(file);
      this.readHunks(file);
    } else if (!described && file.kind !== "binary")
      throw new NotStrict(file.start, "starts a git file with nothing after it");
    this.files.push(file);
    this.region = "between";
  }

  private readPlainFile(): void {
    const file: StrictFile = {
      commit: this.commit,
      start: this.at,
      kind: "text",
      names: [],
      change: "modified",
      additions: 0,
      deletions: 0,
    };
    this.readNames(file);
    this.readHunks(file);
    this.files.push(file);
    this.region = "between";
  }

  /** The `---`/`+++` pair: both present, each naming a file. */
  private readNames(file: StrictFile): void {
    const old = this.source[this.at]!;
    const next = this.source[this.at + 1] ?? "";
    if (!old.startsWith("--- ") || !next.startsWith("+++ "))
      throw new NotStrict(this.at, "starts a file header without its +++ line");
    for (const [index, line] of [old, next].entries()) {
      const name = headerName(line.slice(4), this.at + index);
      if (name === "") throw new NotStrict(this.at + index, "names no file");
      if (name === "/dev/null") file.change = index === 0 ? "added" : "deleted";
      file.names.push(name);
    }
    this.at += 2;
    if (!HUNK_HEADER.test(this.source[this.at] ?? ""))
      throw new NotStrict(this.at - 2, "has a file header with no hunk after it");
  }

  private readHunks(file: StrictFile): void {
    let last: { old: number; oldCount: number; next: number; nextCount: number } | null = null;
    while (this.source[this.at]?.startsWith("@@")) {
      const header = HUNK_HEADER.exec(this.source[this.at]!);
      if (!header) throw new NotStrict(this.at, "has a hunk header that doesn't parse");
      const hunk = {
        old: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        next: Number(header[3]),
        nextCount: header[4] === undefined ? 1 : Number(header[4]),
      };
      // Hunks run forward: one that starts inside the one before it has an unsure boundary.
      if (
        last &&
        (hunk.old < last.old + last.oldCount ||
          hunk.next < last.next + last.nextCount ||
          hunk.old <= last.old ||
          hunk.next <= last.next)
      )
        throw new NotStrict(this.at, "starts a hunk inside the range of the hunk before it");
      last = hunk;
      this.at++;
      this.readHunkBody(file, hunk.oldCount, hunk.nextCount);
    }
    // A + - or space line after the last hunk falls between files, where no such line may be.
    file.kind = "text";
  }

  private readHunkBody(file: StrictFile, oldCount: number, nextCount: number): void {
    let old = oldCount;
    let next = nextCount;
    const start = this.at - 1;
    while (old > 0 || next > 0) {
      const line = this.source[this.at];
      if (line === undefined) throw new NotStrict(start, "ends before the lines its header counts");
      const mark = line === "" ? " " : line[0];
      if (mark === " ") {
        old--;
        next--;
      } else if (mark === "-") {
        old--;
        file.deletions++;
      } else if (mark === "+") {
        next--;
        file.additions++;
      } else if (mark !== "\\") throw new NotStrict(this.at, "breaks off the hunk above it");
      if (old < 0 || next < 0)
        throw new NotStrict(start, "holds more lines than its header counts");
      this.at++;
    }
    while (this.source[this.at]?.startsWith("\\")) this.at++;
  }

  /** `literal`/`delta` blocks of base85 lines, each closed by a blank line. */
  private skipBinaryBody(): void {
    this.at++;
    while (this.at < this.source.length) {
      const line = this.source[this.at]!;
      if (/^(?:literal|delta) \d+$/.test(line) || /^[A-Za-z][!-~]*$/.test(line)) this.at++;
      else if (line === "") {
        this.at++;
        if (!/^(?:literal|delta) \d+$/.test(this.source[this.at] ?? "")) return;
      } else return;
    }
  }
}

function mailCommit(fields: Map<string, string>): StrictCommit {
  const subject = fields.get("Subject");
  const author = fields.get("From");
  return {
    start: -1,
    id: null,
    subject:
      subject === undefined ? null : decodeHeader(subject).replace(/^\[[^\]]*\]\s*/, "") || null,
    author: author === undefined ? null : decodeHeader(author),
    date: fields.get("Date") ?? null,
  };
}

function logCommit(fields: Map<string, string>, subject: string | null): StrictCommit {
  let date: string | null = null;
  for (const [name, value] of fields) if (name === "Date" || name === "AuthorDate") date = value;
  return { start: -1, id: null, subject, author: fields.get("Author") ?? null, date };
}

/** The change a git extended header line names, if any. */
function changeOf(line: string): StrictFile["change"] | null {
  if (line.startsWith("new file mode ")) return "added";
  if (line.startsWith("deleted file mode ")) return "deleted";
  if (line.startsWith("rename to ")) return "renamed";
  if (line.startsWith("copy to ")) return "copied";
  return null;
}

function boundaryOf(value: string): string | null {
  const match = /^multipart\/.*\bboundary="?([^";\s]+)/i.exec(value);
  return match ? match[1]! : null;
}

/** Every split of `text` at a space, each side whole: how a bare line's two names may part. */
function halves(text: string, join: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf(join); at >= 0; at = text.indexOf(join, at + 1))
    out.push(text.slice(0, at), text.slice(at + join.length));
  return out;
}

/** A `---`/`+++` value: a C-quoted name, or the text before a tab and its timestamp. */
function headerName(value: string, line: number): string {
  if (value.startsWith('"')) {
    const end = closing(value);
    if (end > 0) return unquote(value.slice(0, end + 1), line);
  }
  // Before a tab, the name is exact: git ends a name with trailing spaces in one.
  const tab = value.indexOf("\t");
  return tab < 0 ? value.trimEnd() : value.slice(0, tab);
}

/** The names a `diff --git` line gives: each C-quoted side, or the line itself when bare. */
function gitLineNames(rest: string): string[] {
  if (!rest.includes('"')) return halves(rest, " ");
  const names: string[] = [];
  let index = 0;
  while (index < rest.length) {
    if (rest[index] === " ") index++;
    else if (rest[index] === '"') {
      const end = closing(rest.slice(index));
      if (end < 0) return halves(rest, " ");
      names.push(unquote(rest.slice(index, index + end + 1), -1));
      index += end + 1;
    } else {
      const space = rest.indexOf(" ", index);
      names.push(rest.slice(index, space < 0 ? rest.length : space));
      index = space < 0 ? rest.length : space;
    }
  }
  return names;
}

/** The names of a standalone `Binary files A and B differ`, the whole middle when it can't split. */
function binaryNames(line: string, at: number): string[] {
  if (!line.endsWith(" differ"))
    throw new NotStrict(at, "starts like a binary record but isn't one");
  const middle = line.slice("Binary files ".length, -" differ".length);
  const names = halves(middle, " and ").map(shellWord);
  if (names.length === 0 || names.some((name) => name === ""))
    throw new NotStrict(at, "names no binary files");
  return names;
}

/** A name GNU diff wrote as a shell word ('…', "…", $'…'), unquoted; a bare name as it is. */
function shellWord(text: string): string {
  if (!/^(?:['"]|\$')/.test(text)) return text;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const add = (chars: string) => bytes.push(...encoder.encode(chars));
  let index = 0;
  while (index < text.length) {
    if (text[index] === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return text;
      add(text.slice(index + 1, end));
      index = end + 1;
    } else if (text.startsWith("$'", index)) {
      const end = dollarWord(text, index + 2, bytes);
      if (end < 0) return text;
      index = end;
    } else if (text[index] === '"') {
      const end = doubleWord(text, index + 1, add);
      if (end < 0) return text;
      index = end;
    } else if (text[index] === "\\" && index + 1 < text.length) {
      add(text[index + 1]!);
      index += 2;
    } else return text;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(bytes));
}

const DOLLAR_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  e: 27,
  E: 27,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  "\\": 92,
  "'": 39,
  '"': 34,
};

/** A "…" word's characters from `index`, its backslash escapes read; the index past its quote, or -1. */
function doubleWord(text: string, index: number, add: (chars: string) => void): number {
  for (let at = index; at < text.length; at++) {
    if (text[at] === '"') return at + 1;
    if (text[at] === "\\" && /[\\"$`]/.test(text[at + 1] ?? "")) at++;
    const point = String.fromCodePoint(text.codePointAt(at)!);
    add(point);
    at += point.length - 1;
  }
  return -1;
}

/** A $'…' word's bytes from `index`, its C escapes read; the index past its quote, or -1. */
function dollarWord(text: string, index: number, bytes: number[]): number {
  const encoder = new TextEncoder();
  for (let at = index; at < text.length; at++) {
    const char = text[at]!;
    if (char === "'") return at + 1;
    if (char !== "\\") {
      const point = String.fromCodePoint(text.codePointAt(at)!);
      bytes.push(...encoder.encode(point));
      at += point.length - 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1, at + 4));
    const hex = text[at + 1] === "x" ? /^[0-9A-Fa-f]{1,2}/.exec(text.slice(at + 2, at + 4)) : null;
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      at += octal[0].length;
    } else if (hex) {
      bytes.push(Number.parseInt(hex[0], 16));
      at += hex[0].length + 1;
    } else {
      const escaped = text[at + 1] ?? "";
      bytes.push(
        ...(DOLLAR_ESCAPES[escaped] === undefined
          ? encoder.encode(escaped)
          : [DOLLAR_ESCAPES[escaped]!]),
      );
      at++;
    }
  }
  return -1;
}

const ENCODED = /^=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=$/;

/**
 * A mail header's RFC 2047 encoded words decoded. Adjacent words in one
 * charset, parted only by whitespace, decode as one run of bytes.
 */
function decodeHeader(value: string): string {
  const parts = value.split(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/);
  let out = "";
  let run: { charset: string; bytes: number[] } | null = null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (index % 2 === 0) {
      const joins =
        run !== null &&
        part.trim() === "" &&
        index + 1 < parts.length &&
        ENCODED.exec(parts[index + 1]!)![1]!.toLowerCase() === run.charset;
      if (joins) continue;
      out += decodeRun(run) + part;
      run = null;
      continue;
    }
    const [, charset, encoding, data] = ENCODED.exec(part)!;
    run ??= { charset: charset!.toLowerCase(), bytes: [] };
    run.bytes.push(...wordData(encoding!, data!));
  }
  return out + decodeRun(run);
}

function decodeRun(run: { charset: string; bytes: number[] } | null): string {
  if (run === null) return "";
  try {
    return new TextDecoder(run.charset).decode(Uint8Array.from(run.bytes));
  } catch {
    return String.fromCharCode(...run.bytes);
  }
}

function wordData(encoding: string, data: string): number[] {
  if (/b/i.test(encoding)) {
    try {
      return [...atob(data)].map((char) => char.charCodeAt(0));
    } catch {
      return [];
    }
  }
  return [
    ...data.replace(/=([0-9A-Fa-f]{2})|_/g, (match, hex: string | undefined) =>
      hex === undefined ? " " : String.fromCharCode(Number.parseInt(hex, 16)),
    ),
  ].map((char) => char.charCodeAt(0));
}

function closing(text: string): number {
  for (let index = 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index;
  }
  return -1;
}

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** git's C quoting undone, octal escapes read as UTF-8 bytes; the text itself when bare. */
function unquote(text: string, line: number): string {
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < text.length - 1; index++) {
    const char = text[index]!;
    if (char !== "\\") {
      // A whole code point, so a character outside the BMP encodes as itself, not as two halves.
      const point = String.fromCodePoint(text.codePointAt(index)!);
      for (const byte of encoder.encode(point)) bytes.push(byte);
      index += point.length - 1;
      continue;
    }
    const rest = text.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(rest)) {
      bytes.push(Number.parseInt(rest, 8));
      index += 3;
    } else if (ESCAPES[text[index + 1] ?? ""] !== undefined) {
      bytes.push(ESCAPES[text[index + 1]!]!);
      index++;
    } else throw new NotStrict(line, "has a quoted name with an escape git doesn't write");
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(bytes));
}
