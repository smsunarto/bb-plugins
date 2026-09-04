const SEPARATOR = "-";
const MAX_LENGTH = 80;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Turns arbitrary heading text into a URL segment.
 *
 * Combining marks are dropped after NFKD normalisation, so a heading typed with
 * a precomposed accented letter and one typed with a separate accent land on
 * the same anchor.
 */
export function slugify(input: string): string {
  const unmarked = input.normalize("NFKD").replace(COMBINING_MARKS, "");
  return trimSeparators(unmarked.replace(/[^A-Za-z0-9]+/g, SEPARATOR));
}

/**
 * Shortens a slug to `maxLength`, cutting on the last separator so the tail is
 * a whole word rather than a fragment.
 */
export function truncateSlug(slug: string, maxLength: number = MAX_LENGTH): string {
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastBreak = cut.lastIndexOf(SEPARATOR);
  return trimSeparators(lastBreak > 0 ? cut.slice(0, lastBreak) : cut);
}

/** True when `value` is already a slug, so slugifying it again is a no-op. */
export function isSlug(value: string): boolean {
  return value.length > 0 && value === slugify(value);
}

function trimSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === SEPARATOR) start += 1;
  while (end > start && value[end - 1] === SEPARATOR) end -= 1;
  return value.slice(start, end);
}
