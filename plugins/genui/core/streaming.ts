// Compiles a spec while its source is still streaming in: renders the longest
// prefix that compiles, cut at an element boundary with its brackets closed.
import type { Program } from "./ast";
import { compile } from "./index";
import type { Diagnostic } from "./types";

/** Cut points tried, latest first, before giving up on a prefix. */
const MAX_ATTEMPTS = 12;

const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * Components whose strings are text the reader reads, so a half-written one
 * can show as it streams. Everything else waits for its closing quote: a half
 * path would be read (Load, Snippet, Image), a half place name looked up
 * (Map), a half query searched (ImageSearch), a half icon or Mermaid source
 * fail to draw, and a half label sent if tapped (Button, FollowUps, Plan).
 */
const PROSE_CALLS: Record<string, true> = {
  Card: true, Details: true, Tabs: true, Text: true, Callout: true, Metric: true, Badge: true, KeyValue: true,
  List: true, Table: true, Steps: true, Timeline: true, Code: true, Walkthrough: true, Quiz: true,
  Flashcards: true, Findings: true,
};

/** Object keys and named args whose strings are references or enums, never prose. */
const REFERENCE_KEYS: Record<string, true> = {
  icon: true, image: true, src: true, url: true, path: true, file: true, query: true, tone: true, status: true,
  severity: true, variant: true, language: true, kind: true, type: true, date: true, month: true, action: true,
};

/** `source.slice(0, end) + closers` is a candidate prefix. */
interface Cut {
  readonly end: number;
  readonly closers: string;
}

/**
 * Compiles a spec that may still be streaming. If the whole source compiles,
 * returns it with `complete: true`. Otherwise compiles the longest prefix that
 * does: cut at the last argument/element boundary (after a `,` or an opening
 * bracket, or at a top-level statement separator), drop trailing commas and
 * any unterminated template or comment, and append closers for every open
 * bracket in order. A string still being written on the last line is closed
 * where it stops when it is prose (see PROSE_CALLS), so a paragraph grows as
 * it streams instead of appearing whole at its closing quote; other open
 * strings are dropped. Tries cut points from the end backwards (at most 12)
 * and returns the first prefix that compiles, with `complete: false` and the
 * FULL source's diagnostics (so a finished-but-broken spec can still be
 * reported). `program` is null only when no prefix compiles (e.g. only state
 * declarations so far, or empty).
 */
export function compileStreaming(source: string): {
  program: Program | null;
  diagnostics: Diagnostic[];
  complete: boolean;
} {
  const full = compile(source);
  if (full.program !== null) return { ...full, complete: true };
  const cuts = lastCuts(source);
  for (let k = cuts.length - 1; k >= 0; k--) {
    const { program } = compile(source.slice(0, cuts[k].end) + cuts[k].closers);
    if (program !== null) return { program, diagnostics: full.diagnostics, complete: false };
  }
  return { program: null, diagnostics: full.diagnostics, complete: false };
}

/**
 * The last MAX_ATTEMPTS cut points in source order. Scanning stops at the
 * first unterminated string, template or comment: no prefix containing one
 * can compile, so every cut lies before it, except the open prose string
 * closed in place (the last cut).
 */
function lastCuts(source: string): Cut[] {
  const cuts: Cut[] = [];
  /** Closers for the open brackets, innermost first. */
  let closers = "";
  /** For each open bracket, outermost first: the component a `(` calls, else null. */
  const callees: (string | null)[] = [];
  /** Code since the last cut, so blank lines add no duplicate cut. */
  let pending = false;
  const record = (end: number, close = closers) => {
    cuts.push({ end, closers: close });
    if (cuts.length > MAX_ATTEMPTS) cuts.shift();
    pending = false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const end = skipLiteral(source, i);
    if (end === -1) {
      if ((c === '"' || c === "'") && !source.includes("\n", i) && isProse(source.slice(0, i), callees)) {
        // An odd run of trailing backslashes is an escape cut in half.
        const cut = source.length - (/\\*$/.exec(source)![0].length % 2);
        record(cut, mendMarkdown(source.slice(i + 1, cut)) + c + closers);
      }
      break;
    }
    if (end > i) {
      i = end - 1;
      if (c === "/") {
        // A comment ends before its newline, which is then scanned as a separator.
      } else if (closers !== "") {
        // Right after a string: what streamed into it stays shown while the
        // expression it starts (`"$" + price`) is still being written.
        record(end);
      } else {
        pending = true;
      }
    } else if (c === "(" || c === "[" || c === "{") {
      closers = CLOSER[c] + closers;
      callees.push(c === "(" ? (/([A-Za-z_]\w*)\s*$/.exec(source.slice(Math.max(0, i - 40), i))?.[1] ?? null) : null);
      record(i + 1);
    } else if (c === ")" || c === "]" || c === "}") {
      closers = closers.slice(1);
      callees.pop();
      pending = true;
    } else if (c === ",") {
      record(i);
    } else if (c === "\n" || c === ";") {
      if (closers === "" && pending) record(i);
    } else if (c !== " " && c !== "\t" && c !== "\r") {
      pending = true;
    }
  }
  return cuts;
}

/** Whether a string opened right after `before` is prose inside a PROSE_CALLS component. */
function isProse(before: string, callees: readonly (string | null)[]): boolean {
  const callee = callees.filter((name) => name !== null).pop();
  if (callee === undefined || !Object.hasOwn(PROSE_CALLS, callee)) return false;
  const key = /([A-Za-z_]\w*)\s*:\s*$/.exec(before)?.[1];
  return key === undefined || !Object.hasOwn(REFERENCE_KEYS, key);
}

/**
 * Closers for the markdown a half-written string leaves open, so the run is
 * styled while it streams instead of showing literal markers that vanish when
 * the closer arrives (and reflow the paragraph). After Zeron's `mend`, which
 * does the same for streamed markdown: an open code span closes with `` ` ``,
 * else an open `**` with `**` (or `*` when the closer is half written). An
 * opener with nothing after it stays literal until content follows.
 */
function mendMarkdown(text: string): string {
  if ((text.match(/`/g)?.length ?? 0) % 2 === 1) return /`\s*$/.test(text) ? "" : "`";
  if ((text.match(/\*\*/g)?.length ?? 0) % 2 === 0) return "";
  if (/\*\*\s*$/.test(text)) return "";
  return text.endsWith("*") ? "*" : "**";
}

/**
 * For a string, template or `//` comment starting at `i`: the index just past
 * it (a comment stops before its newline), or -1 if it is unterminated.
 * Anywhere else: `i`.
 */
function skipLiteral(source: string, i: number): number {
  const c = source[i];
  if (c === "/" && source[i + 1] === "/") return source.indexOf("\n", i);
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < source.length; j++) {
      const d = source[j];
      if (d === c) return j + 1;
      if (d === "\n") return -1;
      if (d === "\\") j++;
    }
    return -1;
  }
  if (c === "`") {
    for (let j = i + 1; j < source.length; j++) {
      const d = source[j];
      if (d === "`") return j + 1;
      if (d === "\\") {
        j++;
      } else if (d === "$" && source[j + 1] === "{") {
        j = skipInterpolation(source, j + 2);
        if (j === -1) return -1;
        j--;
      }
    }
    return -1;
  }
  return i;
}

/** From inside a template's `${`: the index just past its `}`, or -1 if it never closes. */
function skipInterpolation(source: string, i: number): number {
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    const end = skipLiteral(source, j);
    if (end === -1) return -1;
    if (end > j) {
      j = end - 1;
      continue;
    }
    const c = source[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === "}" && depth === 0) return j + 1;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
  }
  return -1;
}
