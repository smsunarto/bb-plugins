/** Vimium's default hintCharacters. */
export const HINT_ALPHABET = "sadfjklewcmpgh";

/**
 * The same characters reordered for dropdown reprompts: index fingers first,
 * then middle, ring, pinky, so the first few options land on the strongest
 * home-row keys.
 */
export const DROPDOWN_ALPHABET = "fjdkslahgewcmp";

/**
 * bb's stable controls, each pinned to one character so the binding never
 * shifts with what else is on screen. Only built-ins get single-character
 * labels; plugin-contributed buttons come and go, so a single character there
 * would never stay stable enough for muscle memory. Entries match nothing on
 * screens without their control, and their characters stay carved out of the
 * general alphabet anyway.
 */
export const RESERVED_CONTROLS = [
  {
    selector: '[data-app-composer] button[aria-label^="Provider, model"]',
    char: "m",
    nativePicker: "model",
  },
  {
    selector: "[data-app-composer] [data-promptbox-project-control]",
    char: "p",
    nativePicker: "project",
  },
  { selector: '[data-app-composer] [role="textbox"]', char: "i" },
  { selector: '[data-app-composer] button[aria-label="Prompt actions"]', char: "a" },
  { selector: '[data-app-composer] button[aria-label="Start voice input"]', char: "v" },
  { selector: "[data-app-composer] [data-promptbox-submit-action]", char: "j" },
  { selector: '[data-app-composer] button[aria-label="Permission mode"]', char: "k" },
  {
    selector:
      '[data-app-composer] button[aria-label="Machine"], [data-app-composer] button[aria-label="Environment"]',
    char: "l",
    nativePicker: "machine",
  },
  { selector: '[data-app-composer] button[aria-label="Branch"]', char: "b" },
  // List rows have stable ids; the rail header loses its label when unbound.
  {
    selector:
      '[data-sidebar-navigation-item="__bb__/new-thread"] > button, button[aria-label="New thread"], button[aria-label^="New thread ("]',
    char: "n",
    fallback: { selector: "[data-sidebar-header-slot] button", text: "New thread" },
  },
  {
    selector:
      '[data-sidebar-navigation-item="__bb__/search-threads"] > button, button[aria-label="Search threads"], button[aria-label^="Search threads ("]',
    char: "s",
  },
  {
    selector:
      ':is(nav[aria-label="Primary navigation"], [data-testid="app-nav-rail"]) button[aria-label="Home"]',
    char: "h",
  },
  { selector: 'button[aria-label="Go back"]', char: "[" },
  { selector: 'button[aria-label="Go forward"]', char: "]" },
  {
    selector:
      ':is(nav[aria-label="Primary navigation"], [data-testid="app-nav-rail"]) button:is([aria-label="More"], [aria-label^="More, "]), [data-sidebar-navigation-item="__bb__/extensions"] > button, [data-testid="sidebar-navigation-list"] > button[aria-haspopup="menu"]',
    char: "e",
  },
  {
    selector:
      'button[aria-label="Settings"], button[aria-label^="Settings ("], a[aria-label="Settings"], a[aria-label^="Settings ("], a[href="/settings"]',
    char: ",",
  },
  { selector: 'button[aria-label^="Toggle sidebar"]', char: "q" },
  {
    selector: 'button[aria-label^="Show right panel"], button[aria-label^="Hide right panel"]',
    char: "\\",
  },
] as const;

/** Named controls may omit aria-label when their BB shortcut is unbound. */
export function matchesReservedControl(
  element: Element,
  control: (typeof RESERVED_CONTROLS)[number],
): boolean {
  if (element.matches(control.selector)) return true;
  return (
    "fallback" in control &&
    element.matches(control.fallback.selector) &&
    element.textContent?.trim() === control.fallback.text
  );
}

/** Thread rows count across the number row in list order, then fall back to letters. */
export const THREAD_DIGITS = "1234567890";

const RESERVED_CHARS = new Set<string>(RESERVED_CONTROLS.map((control) => control.char));

/**
 * The alphabet for everything that is not a reserved control or a thread row.
 * Reserved characters are carved out even when their control is off screen,
 * so no general label ever starts with one and the whole set stays
 * prefix-free. The reserved controls remove most home-row characters, and a
 * thread with an open diff panel can exceed the remaining two-character range.
 * Extra characters extend the general set past 196 two-character labels.
 */
const EXTRA_GENERAL_CHARS = "uortnbiyqxz;/";
export const GENERAL_ALPHABET = [...(HINT_ALPHABET + EXTRA_GENERAL_CHARS)]
  .filter((char) => !RESERVED_CHARS.has(char))
  .join("");

export type ScopedKind = "generic" | "reasoning" | "permission";

export interface ScopedFact {
  readonly role: "permission" | "other";
}

/** Popup choices follow their visible order; reasoning uses the number row. */
export function assignScopedLabels(kind: ScopedKind, facts: readonly ScopedFact[]): string[] {
  if (kind === "reasoning") return hintLabels(facts.length, THREAD_DIGITS);
  if (kind === "generic") return hintLabels(facts.length, DROPDOWN_ALPHABET);
  const chars = "asdfgh";
  let next = 0;
  const labels = facts.map((fact) =>
    fact.role === "permission" && next < chars.length ? chars.charAt(next++) : null,
  );
  const fallback = hintLabels(labels.filter((label) => label === null).length);
  let missing = 0;
  return labels.map((label) => label ?? "q" + fallback[missing++]);
}

/** What the top-level labeler needs to know about one hint target, in DOM order. */
export interface TopLevelFact {
  readonly reservedChar: string | null;
  readonly isThreadRow: boolean;
}

/**
 * Labels for a top-level prompt: reserved composer controls keep their pinned
 * character (first match wins if the selector somehow matches twice), the
 * first ten thread rows count 1-0, and everything else gets two-character
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
