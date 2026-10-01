const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".aws-sam",
  ".cache",
  ".cc-writes",
  ".git",
  ".gitbutler",
  ".hg",
  ".jj",
  ".mypy_cache",
  ".next",
  ".node_modules",
  ".nox",
  ".nuxt",
  ".nx",
  ".output",
  ".parcel-cache",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".scratch",
  ".serverless",
  ".svelte-kit",
  ".svn",
  ".terraform",
  ".tmp",
  ".tox",
  ".turbo",
  ".venv",
  ".vercel",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "jspm_packages",
  "node_modules",
  "out",
  "target",
  "temp",
  "tmp",
  "vendor",
  "venv",
]);

const EXCLUDED_CHILD_DIRECTORIES = new Map([
  [".cargo", new Set(["git", "registry"])],
  [".claude", new Set(["worktrees"])],
  [".yarn", new Set(["cache", "unplugged"])],
]);

export function isExcludedDocsPath(value: string): boolean {
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  return segments.some((segment, index) => {
    if (EXCLUDED_DIRECTORY_NAMES.has(segment)) return true;
    const parent = segments[index - 1];
    return parent !== undefined && EXCLUDED_CHILD_DIRECTORIES.get(parent)?.has(segment) === true;
  });
}
