/** Vimium's default hintCharacters. */
export const HINT_ALPHABET = "sadfjklewcmpgh";

/**
 * The same characters reordered for dropdown reprompts: index fingers first,
 * then middle, ring, pinky, so the first few options land on the strongest
 * home-row keys.
 */
export const DROPDOWN_ALPHABET = "fjdkslahgewcmp";

/**
 * bb's built-in composer controls, each pinned to one mnemonic character so
 * the binding never shifts with what else is on screen: m(odel), p(roject),
 * a(ctions), v(oice), s(end). Only these built-ins get single-character
 * labels; plugin-contributed buttons come and go, so a single character there
 * would never stay stable enough for muscle memory.
 */
export const RESERVED_COMPOSER_CONTROLS = [
  { selector: '[data-app-composer] button[aria-label^="Provider, model"]', char: "m" },
  { selector: "[data-app-composer] [data-promptbox-project-control]", char: "p" },
  { selector: '[data-app-composer] button[aria-label="Prompt actions"]', char: "a" },
  { selector: '[data-app-composer] button[aria-label="Start voice input"]', char: "v" },
  { selector: "[data-app-composer] [data-promptbox-submit-action]", char: "s" },
] as const;

/** Thread rows count up from 1 in list order, ten and beyond fall back to letters. */
export const THREAD_DIGITS = "123456789";

const RESERVED_CHARS = new Set<string>(RESERVED_COMPOSER_CONTROLS.map((control) => control.char));

/**
 * The alphabet for everything that is not a reserved control or a thread row.
 * Reserved characters are carved out even when their control is off screen,
 * so no general label ever starts with one and the whole set stays
 * prefix-free.
 */
export const GENERAL_ALPHABET = [...HINT_ALPHABET]
  .filter((char) => !RESERVED_CHARS.has(char))
  .join("");

/** What the top-level labeler needs to know about one hint target, in DOM order. */
export interface TopLevelFact {
  readonly reservedChar: string | null;
  readonly isThreadRow: boolean;
}

/**
 * Labels for a top-level prompt: reserved composer controls keep their pinned
 * character (first match wins if the selector somehow matches twice), the
 * first nine thread rows count 1-9, and everything else gets two-character
 * general labels — never one, so a stray button can't squat on a character a
 * user has learned.
 */
export function assignTopLevelLabels(facts: readonly TopLevelFact[]): string[] {
  const taken = new Set<string>();
  const labels: (string | null)[] = facts.map((fact) => {
    if (fact.reservedChar !== null && !taken.has(fact.reservedChar)) {
      taken.add(fact.reservedChar);
      return fact.reservedChar;
    }
    return null;
  });
  let nextDigit = 0;
  for (const [index, fact] of facts.entries()) {
    if (labels[index] === null && fact.isThreadRow && nextDigit < THREAD_DIGITS.length) {
      labels[index] = THREAD_DIGITS.charAt(nextDigit);
      nextDigit += 1;
    }
  }
  const generalCount = labels.filter((label) => label === null).length;
  const general = hintLabels(generalCount, GENERAL_ALPHABET, 2);
  let nextGeneral = 0;
  return labels.map((label) => label ?? general[nextGeneral++] ?? "");
}

/**
 * Labels for `count` hints, all of the same length — the smallest length of
 * at least `minLength` that fits `count`. Uniform length makes the set
 * prefix-free, so the moment the typed characters equal a label, that label
 * is the unambiguous choice.
 */
export function hintLabels(
  count: number,
  alphabet: string = HINT_ALPHABET,
  minLength = 1,
): string[] {
  if (count <= 0) return [];
  const base = alphabet.length;
  let length = minLength;
  while (base ** length < count) length += 1;
  const labels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let rest = index;
    let label = "";
    for (let position = 0; position < length; position += 1) {
      label = alphabet.charAt(rest % base) + label;
      rest = Math.floor(rest / base);
    }
    labels.push(label);
  }
  return labels;
}
