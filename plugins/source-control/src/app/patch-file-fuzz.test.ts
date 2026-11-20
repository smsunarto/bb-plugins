/**
 * Every fixture, and seeded mutations of each, either reads as text or draws
 * faithfully: Pierre's lines match each hunk header, and, for diffs without
 * commit messages, every `+`/`-` line of the source is counted in a card.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { readPatchFile } from "../core/patch-file.ts";
import { parsePatch } from "./file-cards.tsx";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/patch-file");
const corpus = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
  .filter((name) => /\.(?:patch|diff)$/.test(name))
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

/**
 * The source's `+` and `-` lines from its first file on, file headers and
 * signatures aside, for a diff with no commit messages: a count the parser
 * does not make.
 */
function sourceChanges(text: string) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  let additions = 0;
  let deletions = 0;
  // Text before the first file is a preamble, as git apply reads it.
  const first = lines.findIndex(
    (line, index) =>
      line.startsWith("diff --git ") ||
      line.startsWith("Binary files ") ||
      (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")),
  );
  let trailers = 0;
  for (let index = Math.max(first, 0); index < lines.length; index++) {
    const line = lines[index]!;
    // A file's `---`/`+++` pair is followed by its first hunk header.
    const header =
      (line.startsWith("--- ") &&
        lines[index + 1]?.startsWith("+++ ") &&
        lines[index + 2]?.startsWith("@@")) ||
      (line.startsWith("+++ ") &&
        lines[index - 1]?.startsWith("--- ") &&
        lines[index + 1]?.startsWith("@@"));
    if (header) continue;
    // A signature may also be a hunk's deletion of "-" or "- ", when its counts say so.
    if (line === "-- " || line === "--") trailers++;
    else if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions, trailers };
}

const hasMessages = (text: string) =>
  /^(?:From [0-9a-f]{40} |commit [0-9a-f]{7,})/m.test(text) || /^GIT binary patch$/m.test(text);

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
  if (hasMessages(text) || read.read.omitted > 0) return;
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
