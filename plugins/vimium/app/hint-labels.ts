/** Vimium's default hintCharacters. */
export const HINT_ALPHABET = "sadfjklewcmpgh";

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
