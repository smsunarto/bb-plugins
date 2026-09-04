// Zod-free so the browser bundle and the other value-safe shared modules can
// import it.

function levenshtein(a: string, b: string): number {
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? 0;
      const left = previous[j - 1] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, left + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return at === needle.length;
}

// Close typos win on edit distance; abbreviations like `gh` or `BC` fall back
// to the shortest name that contains the typo's letters in order.
export function suggest(
  typo: string,
  names: readonly string[],
  maxDistance = 2,
): string | undefined {
  const needle = typo.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = levenshtein(needle, name.toLowerCase());
    if (distance <= maxDistance && (best === undefined || distance < best.distance)) {
      best = { name, distance };
    }
  }
  if (best !== undefined) return best.name;
  if (needle.length === 0) return undefined;
  let abbreviated: string | undefined;
  for (const name of names) {
    if (!isSubsequence(needle, name.toLowerCase())) continue;
    if (abbreviated === undefined || name.length < abbreviated.length) abbreviated = name;
  }
  return abbreviated;
}
