/**
 * Display width in terminal-style columns: one per grapheme, two for an emoji
 * or an East Asian Wide or Fullwidth character (UAX #11, the main blocks).
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|\p{Regional_Indicator}/u;

/** East Asian Wide (W) and Fullwidth (F) code point ranges, inclusive. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initials
  [0x2e80, 0x303e], // CJK radicals, symbols and punctuation
  [0x3041, 0x33ff], // Kana, Bopomofo, Hangul compatibility, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility and small forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1b000, 0x1b2ff], // Kana supplement and extended
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x20000, 0x2fffd], // CJK extensions B to F
  [0x30000, 0x3fffd], // CJK extensions G and H
];

function graphemeWidth(grapheme: string): 1 | 2 {
  if (EMOJI.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
}

/** Columns `text` takes on screen. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment);
  return width;
}

/** `text` cut to at most `columns` columns, ending in "…" when it was cut. */
export function clip(text: string, columns: number): string {
  const kept: string[] = [];
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    width += graphemeWidth(segment);
    if (width > columns) {
      while (kept.length > 0 && displayWidth(`${kept.join("")}…`) > columns) kept.pop();
      return `${kept.join("")}…`;
    }
    kept.push(segment);
  }
  return text;
}
