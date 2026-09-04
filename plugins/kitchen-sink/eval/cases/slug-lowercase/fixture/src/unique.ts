import { slugify, truncateSlug } from "./slug.ts";

const FALLBACK = "section";
const MAX_SUFFIX = 1000;

/**
 * Picks a slug that is not already present in `taken`, appending the smallest
 * numeric suffix that frees one up.
 */
export function uniqueSlug(input: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = truncateSlug(slugify(input)) || FALLBACK;
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < MAX_SUFFIX; suffix += 1) {
    const next = `${base}-${suffix}`;
    if (!used.has(next)) return next;
  }
  throw new Error(`unable to derive a unique slug from "${input}"`);
}

/** Maps headings to anchors in document order, keeping every anchor distinct. */
export function anchorsForHeadings(headings: readonly string[]): Map<string, string> {
  const anchors = new Map<string, string>();
  const used = new Set<string>();
  for (const heading of headings) {
    const anchor = uniqueSlug(heading, used);
    used.add(anchor);
    anchors.set(heading, anchor);
  }
  return anchors;
}
