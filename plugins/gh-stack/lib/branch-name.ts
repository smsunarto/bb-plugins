const BRANCH_CANDIDATE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

const CONVENTIONAL_HEAD =
  /^\s*([A-Za-z]+)\s*(?:\([^)]*\))?\s*!?\s*:\s*(.+)$/;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function deriveBranchName(name: string, conventional: boolean): string {
  if (!conventional) return slugify(name);
  const match = CONVENTIONAL_HEAD.exec(name);
  const slug = slugify(match ? match[2] : name);
  if (!slug) return "";
  return match ? `${match[1].toLowerCase()}-${slug}` : slug;
}

// Fast, conservative preflight before asking Git for authoritative ref
// validation. This also guarantees a candidate cannot be parsed as a flag.
export function isBranchCandidate(branch: string): boolean {
  return BRANCH_CANDIDATE.test(branch);
}

// A configured prefix is a branch namespace and ends on a separator
// ("scott" → "scott/"). Git validates the prefix plus a sentinel component
// before it is persisted; this function only normalizes the user's input.
export function normalizeBranchPrefix(
  raw: string,
): { prefix: string } | { error: string } {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (!trimmed) return { prefix: "" };
  if (!isBranchCandidate(trimmed) || trimmed.endsWith(".")) {
    return {
      error:
        "A branch prefix must start with a letter or digit, cannot end in a dot, and may use only letters, digits, and . _ - /",
    };
  }
  return { prefix: /[/_-]$/.test(trimmed) ? trimmed : `${trimmed}/` };
}
