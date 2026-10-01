import type {
  ReviewDiffSide,
  ReviewFindQuery,
  ReviewInlineFindResult,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { compileReviewFindQuery } from "../vendor/review/app/src/review-find-query.ts";
import type { AlignedRow } from "./two-side.ts";

/** A match on one line: 1-based `line`, 0-based `[start, end)` columns. */
export interface LineMatch {
  line: number;
  start: number;
  end: number;
}

/**
 * Find-in-text over code surface lines, for `setFindQuery` and factory
 * `find`. Monaco semantics, as the Desktop peeks used
 * (`model.findMatches(text, false, isRegex, matchCase, wholeWord ? USUAL_WORD_SEPARATORS : null)`):
 * matches stay within one line, empty matches are skipped, an invalid
 * expression finds nothing, and whole word uses Monaco's word separators.
 */
export function findMatches(
  lines: readonly string[],
  query: ReviewFindQuery,
): ReviewInlineFindResult & { matches: LineMatch[] } {
  const matches: LineMatch[] = [];

  if (!query.text) return { matchCount: 0, matches };
  const compiled = compileReviewFindQuery({ ...query, wholeWord: false });

  if ("error" in compiled) return { matchCount: 0, matches };
  const expression = compiled.expression;

  lines.forEach((text, index) => {
    expression.lastIndex = 0;

    for (;;) {
      const match = expression.exec(text);

      if (!match) break;

      if (match[0].length === 0) {
        expression.lastIndex++;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;

      if (!query.wholeWord || isWholeWord(text, start, end))
        matches.push({ line: index + 1, start, end });
    }
  });

  return { matchCount: matches.length, matches };
}

/** Monaco's `USUAL_WORD_SEPARATORS`. */
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

const isBoundaryCharacter = (character: string) =>
  WORD_SEPARATORS.includes(character) || /\s/.test(character);

/** Monaco `isValidMatch` with a separator classifier. */
function isWholeWord(text: string, start: number, end: number): boolean {
  const left =
    start === 0 || isBoundaryCharacter(text[start - 1]) || isBoundaryCharacter(text[start]);
  const right =
    end === text.length || isBoundaryCharacter(text[end]) || isBoundaryCharacter(text[end - 1]);

  return left && right;
}

/** A match in a two-sided surface: the side, its 1-based line and the row that holds it. */
export interface SurfaceMatch extends LineMatch {
  side: ReviewDiffSide;
  row: number;
}

/**
 * The matches a lensed peek counts, in Desktop's order (base side, then
 * head side; `findDocument` in `reviewDiffViewService.ts`):
 * - only lines on rows the lens keeps (`visible`), so text "Outside lens" is not counted;
 * - a base match on an unchanged line counts once, on the head side.
 */
export function findSurfaceMatches(input: {
  rows: readonly AlignedRow[];
  base: readonly string[];
  head: readonly string[];
  visible: readonly boolean[];
  query: ReviewFindQuery;
}): SurfaceMatch[] {
  const { rows, base, head, visible, query } = input;
  const rowOf = { base: new Map<number, number>(), head: new Map<number, number>() };

  rows.forEach((row, index) => {
    if (row.base !== null) rowOf.base.set(row.base, index);

    if (row.head !== null) rowOf.head.set(row.head, index);
  });
  const out: SurfaceMatch[] = [];

  for (const [side, lines] of [
    ["base", base],
    ["head", head],
  ] as const) {
    for (const match of findMatches(lines, query).matches) {
      const row = rowOf[side].get(match.line - 1);

      if (row === undefined || !visible[row]) continue;
      const paired = rows[row];

      if (side === "base" && paired.head !== null && lines[match.line - 1] === head[paired.head])
        continue;
      out.push({ ...match, side, row });
    }
  }

  return out;
}
