import type { EvalCase } from "./cases.ts";
import { lastProseLine, proseParagraphs, scanDirectives, type Directive } from "./directives.ts";
import { newSideRanges, overlaps } from "./hunks.ts";

export const MAX_RANGE_SPAN = 80;
export const MAX_DIRECTIVES = 6;
export const PROXY_WINDOW = 3;

export type RunOutcome = {
  caseId: string;
  rep: number;
  timedOut: boolean;
  response: string;
  diff: string;
};

export type CriteriaResult = {
  necessity: boolean;
  rangeFits: boolean | null;
  placement: boolean | null;
  coverage: boolean;
  budget: boolean;
  /** Share of the applicable target criteria this run met, 0 to 1. */
  score: number;
  pass: boolean;
  directives: number;
  notes: string[];
};

/** Stable across runs so a judge verdict keeps pointing at the same directive. */
function share(values: Array<boolean | null>): number {
  const applicable = values.filter((value) => value !== null) as boolean[];
  if (applicable.length === 0) return 1;
  return applicable.filter(Boolean).length / applicable.length;
}

export function directiveKey(caseId: string, rep: number, directive: Directive): string {
  return `${caseId}#${rep}#${directive.line}#${directive.raw}`;
}

function mentions(text: string, directive: Directive, anchors: string[]): boolean {
  const haystack = text.toLowerCase();
  if (haystack.includes(directive.path.toLowerCase())) return true;
  const base = directive.path.split("/").pop() ?? directive.path;
  if (base.length > 0 && haystack.includes(base.toLowerCase())) return true;
  return anchors.some((anchor) => anchor.length > 0 && haystack.includes(anchor.toLowerCase()));
}

function proxyHolds(response: string, evalCase: EvalCase, directives: Directive[]): boolean {
  const lines = response.split("\n");
  const anchored = directives.every((directive) => {
    const from = Math.max(0, directive.line - PROXY_WINDOW);
    const window = lines.slice(from, directive.line).join("\n");
    return mentions(window, directive, evalCase.anchorSymbols);
  });
  if (!anchored) return false;
  const prose = lastProseLine(response);
  const parked = directives.every((one) => one.line > prose);
  // A single embed under a single paragraph sits beside its only claim. Anything
  // else parked past the prose had somewhere better to go.
  const dump = directives.length >= 2 || proseParagraphs(response) >= 2;
  return !(parked && dump);
}

export function scoreRun(
  evalCase: EvalCase,
  outcome: RunOutcome,
  placementVerdicts: Map<string, boolean>,
): CriteriaResult {
  const notes: string[] = [];
  if (outcome.timedOut) {
    return {
      necessity: false,
      rangeFits: null,
      placement: null,
      coverage: false,
      budget: true,
      score: 0,
      pass: false,
      directives: 0,
      notes: ["run timed out"],
    };
  }

  const scan = scanDirectives(outcome.response);
  const diffs = scan.directives.filter((one) => one.kind === "diff");
  const codes = scan.directives.filter((one) => one.kind === "code");
  const ranges = newSideRanges(outcome.diff);
  const touched = new Set(
    [...ranges.entries()].filter(([, list]) => list.length > 0).map(([path]) => path),
  );

  let necessity = true;
  const forbidden = evalCase.noDiffFor;
  for (const directive of diffs) {
    if (forbidden === "*") {
      necessity = false;
      notes.push(`smart-diff on ${directive.path} in a read-only request`);
      continue;
    }
    if (forbidden.includes(directive.path)) {
      necessity = false;
      notes.push(`smart-diff on unasked file ${directive.path}`);
      continue;
    }
    if (!touched.has(directive.path)) {
      necessity = false;
      notes.push(`smart-diff on ${directive.path}, which the run never changed`);
    }
  }

  let rangeFits: boolean | null = null;
  if (evalCase.rangeRequiredFor.length > 0) {
    rangeFits = true;
    for (const path of evalCase.rangeRequiredFor) {
      const forPath = diffs.filter((one) => one.path === path);
      if (forPath.length === 0) {
        rangeFits = false;
        notes.push(`no smart-diff for ${path}`);
        continue;
      }
      for (const directive of forPath) {
        if (directive.start === null || directive.end === null) {
          rangeFits = false;
          notes.push(`smart-diff on ${path} has no line range`);
          continue;
        }
        if (directive.end < directive.start) {
          rangeFits = false;
          notes.push(`smart-diff on ${path} has an inverted range`);
          continue;
        }
        if (directive.end - directive.start + 1 > MAX_RANGE_SPAN) {
          rangeFits = false;
          notes.push(`smart-diff on ${path} spans more than ${MAX_RANGE_SPAN} lines`);
          continue;
        }
        if (!overlaps({ start: directive.start, end: directive.end }, ranges.get(path) ?? [])) {
          rangeFits = false;
          notes.push(`smart-diff range on ${path} misses every changed hunk`);
        }
      }
    }
  }

  let placement: boolean | null = null;
  if (scan.directives.length > 0) {
    const judged = scan.directives.every((directive) => {
      const verdict = placementVerdicts.get(directiveKey(evalCase.id, outcome.rep, directive));
      return verdict !== false;
    });
    const proxy = proxyHolds(outcome.response, evalCase, scan.directives);
    if (!judged) notes.push("judge rejected an embed's placement");
    if (!proxy) notes.push("an embed sits away from the claim it supports");
    placement = judged && proxy;
  }

  const coverage =
    evalCase.expectDiffFor.every((path) => diffs.some((one) => one.path === path)) &&
    (evalCase.noDiffFor !== "*" || codes.length > 0);
  if (!coverage) notes.push("an expected embed is missing");

  const budget = scan.directives.length <= MAX_DIRECTIVES && scan.hidden === 0;
  if (!budget) notes.push("too many embeds, or a directive the renderer would swallow");

  return {
    necessity,
    rangeFits,
    placement,
    coverage,
    budget,
    score: share([necessity, rangeFits, placement]),
    pass: necessity && (rangeFits ?? true) && (placement ?? true),
    directives: scan.directives.length,
    notes,
  };
}
