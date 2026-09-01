/** Vimium's default hintCharacters. */
export const HINT_ALPHABET = "sadfjklewcmpgh";

/**
 * The same characters reordered for dropdown reprompts: index fingers first,
 * then middle, ring, pinky, so the first few options land on the strongest
 * home-row keys. Same character set as HINT_ALPHABET, so the active-mode
 * transition accepts these labels unchanged.
 */
export const DROPDOWN_ALPHABET = "fjdkslahgewcmp";

/**
 * Labels for `count` hints, all of the same length — the smallest length that
 * fits `count`. Uniform length makes the set prefix-free, so the moment the
 * typed characters equal a label, that label is the unambiguous choice.
 */
export function hintLabels(count: number, alphabet: string = HINT_ALPHABET): string[] {
  if (count <= 0) return [];
  const base = alphabet.length;
  let length = 1;
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
