/**
 * Every fixture, and seeded mutations of each, either reads as text or draws
 * faithfully: Pierre's lines match each hunk header, and every `+`/`-` line
 * of the source outside commit headers, messages and mail signatures is
 * counted in a card. The reviewer's variations of each fixture draw only
 * what the strict reading lists, file for file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { readPatchFile } from "../core/patch-file.ts";
import { readStrict } from "../core/patch-strict.ts";
import { parsePatch } from "./file-cards.tsx";
import { undrawableFile } from "./patch-file-opener.tsx";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/patch-file");
const all = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" }).filter((name) =>
  /\.(?:patch|diff)$/.test(name),
);
/** Real output from this repository, kept as a regression sample: tested below, not mutated. */
const REAL = "real/corpus/";
const corpus = all
  .filter((name) => !name.startsWith(REAL))
  .map((name) => ({ name, text: readFileSync(join(FIXTURES, name), "utf8") }));
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const INSERTS = [
  "+x",
  "-x",
  " x",
  "",
  "--flag",
  "-- ",
  "--",
  "\\ No newline at end of file",
  "@@ -1 +1 @@",
  "--- a/z",
  "+++ b/z",
  "diff --git a/z b/z",
  "Binary files a/q and b/q differ",
];
const MUTATIONS = 40;

/** mulberry32: the same mutations on every run. */
function random(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return (((value ^ (value >>> 14)) >>> 0) % below) as number;
  };
}

function mutate(text: string, pick: (below: number) => number): string {
  const lines = text.split("\n");
  const at = pick(lines.length);
  switch (pick(5)) {
    case 0:
      lines.splice(at, 1);
      break;
    case 1:
      lines.splice(at, 0, lines[at]!);
      break;
    case 2:
      lines.splice(at, 0, INSERTS[pick(INSERTS.length)]!);
      break;
    case 3: {
      const hunks = lines.flatMap((line, index) => (HUNK.test(line) ? [index] : []));
      const hunk = hunks[pick(Math.max(hunks.length, 1))];
      if (hunk !== undefined)
        lines[hunk] = lines[hunk]!.replace(/\d+/g, (n) =>
          String(Math.max(0, Number(n) + pick(3) - 1)),
        );
      break;
    }
    default:
      lines.length = at;
  }
  return lines.join("\n");
}

/** Old and new line counts the patch's hunk headers state. */
function stated(patch: string) {
  let old = 0;
  let next = 0;
  for (const line of patch.split("\n")) {
    const header = HUNK.exec(line);
    if (!header) continue;
    old += header[1] === undefined ? 1 : Number(header[1]);
    next += header[2] === undefined ? 1 : Number(header[2]);
  }
  return { old, next };
}

const COMMIT = [
  /^From [0-9a-f]{40} Mon Sep 17 00:00:00 2001$/,
  /^From \S+ \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/,
  /^commit [0-9a-f]{7,}/,
];

/**
 * The source's `+` and `-` lines, counted apart from the parser: lines in a
 * preamble, a commit's header and message (up to its first `diff --git`),
 * and a mail's text after its signature are no change; neither are a file's
 * `---`/`+++` pair before its first hunk header.
 */
function sourceChanges(text: string) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const counts = { additions: 0, deletions: 0, trailers: 0 };
  const commit: Commit = {
    inMessage: true,
    mail: false,
    separated: false,
    boundary: null as string | null,
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (startsCommit(line, lines[index + 1] ?? "")) {
      Object.assign(commit, {
        inMessage: true,
        mail: line.startsWith("From "),
        separated: false,
        boundary: null,
      });
      continue;
    }
    if (passMessageLine(line, commit)) continue;
    const pair = startsPair(lines, index);
    if (line.startsWith("diff --git ") || line.startsWith("Binary files "))
      commit.inMessage = false;
    // In a mail, a ---/+++ pair starts a file only past the message's --- line.
    else if (pair && (!commit.mail || commit.separated)) commit.inMessage = false;
    if (commit.inMessage || pair) continue;
    if (commit.mail && line === "-- ") commit.inMessage = true;
    else count(line, counts);
  }
  return counts;
}

type Commit = { inMessage: boolean; mail: boolean; separated: boolean; boundary: string | null };

/** Notes a mail's boundary and `---` line; true for a MIME boundary line, which is no change. */
function passMessageLine(line: string, commit: Commit): boolean {
  if (commit.inMessage && commit.mail) {
    commit.boundary ??=
      /^Content-Type: multipart\/.*boundary="?([^";\s]+)/i.exec(line)?.[1] ?? null;
    if (line === "---") commit.separated = true;
  }
  return (
    commit.boundary !== null &&
    (line === `--${commit.boundary}` || line === `--${commit.boundary}--`)
  );
}

function startsCommit(line: string, next: string): boolean {
  return COMMIT.some((start) => start.test(line)) && /^[A-Za-z][\w-]*:/.test(next);
}

/** A file's `---`/`+++` pair before its first hunk header. */
function startsPair(lines: string[], index: number): boolean {
  const line = lines[index]!;
  const next = lines[index + 1] ?? "";
  return (
    (line.startsWith("--- ") &&
      next.startsWith("+++ ") &&
      Boolean(lines[index + 2]?.startsWith("@@"))) ||
    (line.startsWith("+++ ") &&
      Boolean(lines[index - 1]?.startsWith("--- ")) &&
      next.startsWith("@@"))
  );
}

function count(
  line: string,
  counts: { additions: number; deletions: number; trailers: number },
): void {
  // A signature may also be a hunk's deletion of "-" or "- ", when its counts say so.
  if (line === "-- " || line === "--") counts.trailers++;
  else if (line.startsWith("+")) counts.additions++;
  else if (line.startsWith("-")) counts.deletions++;
}

function checkFaithful(text: string): void {
  const read = readPatchFile(text);
  if (!read.ok) return;
  for (const commit of read.read.commits)
    for (const { file, patch } of commit.files) {
      if (patch.patch === "") continue;
      const drawn = parsePatch(patch.patch);
      expect(drawn, file.path).not.toBeNull();
      const counts = stated(patch.patch);
      expect({ old: drawn!.deletionLines.length, next: drawn!.additionLines.length }).toEqual(
        counts,
      );
      let additions = 0;
      let deletions = 0;
      for (const hunk of drawn!.hunks) {
        additions += hunk.additionLines;
        deletions += hunk.deletionLines;
      }
      expect({ additions, deletions }, file.path).toEqual({
        additions: file.additions,
        deletions: file.deletions,
      });
    }
  if (read.read.omitted > 0) return;
  const { additions, deletions } = read.read;
  const source = sourceChanges(text);
  expect(additions, "every + line of the source is in a card").toBe(source.additions);
  expect(
    deletions - source.deletions,
    "every - line of the source is in a card",
  ).toBeGreaterThanOrEqual(0);
  expect(deletions - source.deletions).toBeLessThanOrEqual(source.trailers);
}

test.each(corpus.map(({ name, text }, seed) => [relative(".", name), text, seed] as const))(
  "%s and %#'s mutations read as text or draw every line",
  (name, text, seed) => {
    checkFaithful(text);
    const pick = random(seed + 1);
    for (let round = 0; round < MUTATIONS; round++) {
      const mutated = mutate(text, pick);
      try {
        checkFaithful(mutated);
      } catch (error) {
        throw new Error(`${name}, mutation ${round}:\n${mutated}\n${String(error)}`, {
          cause: error,
        });
      }
    }
  },
);

/** The reviewers' variations of each input, and the input itself as the control. */
const VARIATIONS: [string, (text: string) => string][] = [
  ["control", (text) => text],
  ["an added line after the end", (text) => `${text.replace(/\n?$/, "\n")}+extra\n`],
  ["a --flag line after the end", (text) => `${text.replace(/\n?$/, "\n")}--flag\n`],
  ["an empty +++ label", (text) => text.replace(/^\+\+\+ .*$/m, "+++ ")],
  ["an empty --- label", (text) => text.replace(/^--- (?=.*\n\+\+\+ )[^\n]*$/m, "--- ")],
  ["no blank before the first diff", (text) => text.replace(/\n\n+(?=diff --git )/, "\n")],
  [
    "the first hunk counts one more",
    (text) =>
      text.replace(
        /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/m,
        (_, a, b, c, d) => `@@ -${a},${Number(b || 1) + 1} +${c},${Number(d || 1) + 1} @@`,
      ),
  ],
  [
    "the first hunk counts one less",
    (text) =>
      text.replace(
        /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/m,
        (_, a, b, c, d) =>
          `@@ -${a},${Math.max(0, Number(b || 1) - 1)} +${c},${Math.max(0, Number(d || 1) - 1)} @@`,
      ),
  ],
  ["an Only in record", (text) => `Only in b: extra\n${text}`],
  [
    "a hunk that starts back at line 1",
    (text) => `${text.replace(/\n?$/, "\n")}@@ -1 +1 @@\n-p\n+q\n`,
  ],
  ["a doubled diff --git line", (text) => text.replace(/^(diff --git .*)$/m, "$1\n$1")],
  // Round 5's: a backslash line git doesn't write, a signature, a no-newline marker at the end.
  [
    "a bad marker after a deletion",
    (text) => text.replace(/^(-[^-].*)$/m, "$1\n\\ arbitrary-marker"),
  ],
  ["a dash signature at the end", (text) => `${text.replace(/\n?$/, "\n")}-- \n2.0\n`],
  [
    "a no-newline marker at the end",
    (text) => `${text.replace(/\n?$/, "\n")}\\ No newline at end of file\n`,
  ],
  [
    "a mail message that runs into its diff",
    (text) => text.replace(/^(Subject: .*)\n(?:.*\n)*?(?=diff --git )/m, "$1\n"),
  ],
];

/** Fixtures that read as text as they are: each is malformed, or one a strict reading can't be sure of. */
const TEXT_CONTROLS = new Set([
  "malformed/badhunk.patch",
  "malformed/git-show-merge-cc.patch",
  "malformed/overcount-plain.diff",
  "malformed/prose.diff",
  "malformed/prose2.patch",
  "malformed/truncated-sig.patch",
  "malformed/undercount.patch",
  "review/omitted.patch",
  "review/plain-context.diff",
  "review/plain-ru-nul.diff",
  "review/svn.diff",
  "review2/format-patch-attach.patch",
  "review2/format-patch-inline.patch",
  "review2/gnu-ru-binary.diff",
  "review2/gnu-ru-names.diff",
  "review2/log-fuller-stat.patch",
  "review2/log-oneline-stat.patch",
  "review2/plain-binary-and.diff",
  "review2/r1-badheader.patch",
  "review2/sig-nospace.patch",
  "review2/trailing-bullets.patch",
  "review2/two-hunks-blank-late.patch",
  "review2/under-blank-extra.patch",
  "review3/log-custom-format.patch",
  "review3/mbox-series.patch",
  "review3/svn-props.diff",
  "review3/under-stray-extra.patch",
  "review4/custom-log.patch",
  "review4/empty-label.diff",
  "review4/mail-separator-removed.patch",
  "review4/only-in.diff",
  "review4/two-files-bad-counts.diff",
  "review5/binary-pair.diff",
  "review5/empty-mail.patch",
  "review5/encoding.patch",
  "review5/inflated-counts.diff",
  "review5/inline.mbox.patch",
  "review5/kind.patch",
  "review5/only.mbox.patch",
  "review5/raw.patch",
  "review5/relay.patch",
  "review5/submodule.patch",
  "review6/binary-conflict.diff",
  "review6/label.diff",
  "review6/marker-start.diff",
  "review6/override0.patch",
  "review6/rawpaths.patch",
  "review6/rename-conflict.diff",
]);

/** What a draw shows, file by file: its commit's subject, path and counts. */
function drawnList(text: string) {
  const read = readPatchFile(text);
  if (!read.ok) return null;
  return read.read.commits.flatMap((commit) =>
    commit.files.map(({ file }) => ({
      subject: commit.subject,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
  );
}

/** The strict reading's list in the same terms, each path checked against the names its record gives. */
function strictList(text: string, paths: readonly string[]) {
  const strict = readStrict(text);
  if (!strict.strict) return null;
  return strict.files.map((file, index) => {
    const path = paths[index] ?? "";
    const named = file.names.some((name) => name === path || name.endsWith(`/${path}`));
    return {
      subject: strict.commits.find((commit) => commit.start === file.commit)?.subject ?? null,
      path: named ? path : `not named in ${JSON.stringify(file.names)}`,
      additions: file.additions,
      deletions: file.deletions,
    };
  });
}

test("every fixture that should draw does, as it is", () => {
  const text = corpus.filter(({ text }) => drawnList(text) === null).map(({ name }) => name);
  expect(new Set(text.map((name) => relative(".", name)))).toEqual(TEXT_CONTROLS);
});

test.each(corpus.map(({ name, text }) => [relative(".", name), text] as const))(
  "%s: no variation draws anything but what a strict reading lists",
  (name, text) => {
    let draws = 0;
    for (const [variation, change] of VARIATIONS) {
      const changed = change(text);
      const drawn = drawnList(changed);
      if (drawn === null) continue;
      draws++;
      expect(drawn, `${name}, ${variation}`).toEqual(
        strictList(
          changed,
          drawn.map(({ path }) => path),
        ),
      );
      try {
        checkFaithful(changed);
      } catch (error) {
        throw new Error(`${name}, ${variation}:\n${changed}\n${String(error)}`, { cause: error });
      }
    }
    // The control draws, at least, unless the fixture reads as text as it is.
    if (!TEXT_CONTROLS.has(name)) expect(draws, name).toBeGreaterThan(0);
  },
);

test("every git show, git format-patch and git diff of 20 commits from this repository draws", () => {
  const real = all.filter((name) => name.startsWith(REAL));
  expect(real.length).toBe(60);
  for (const name of real) {
    const read = readPatchFile(readFileSync(join(FIXTURES, name), "utf8"));
    if (!read.ok) throw new Error(`${name}: ${read.reason}`);
    expect(undrawableFile(read.read), name).toBeNull();
    checkFaithful(readFileSync(join(FIXTURES, name), "utf8"));
  }
});
