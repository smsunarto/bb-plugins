import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export type PreviewKind = "html" | "markdown";

const PREVIEW_KIND_BY_EXTENSION: ReadonlyMap<string, PreviewKind> = new Map([
  [".html", "html"],
  [".htm", "html"],
  [".md", "markdown"],
  [".markdown", "markdown"],
]);

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

export function previewKind(file: string): PreviewKind {
  const kind = PREVIEW_KIND_BY_EXTENSION.get(posix.extname(file).toLowerCase());
  if (kind === undefined) {
    throw new Error(
      `"file" must end with .html, .htm, .md, or .markdown, got ${JSON.stringify(file)}`,
    );
  }
  return kind;
}

export function requireRelativePreviewFile(value: unknown): string {
  const file = requireNonEmptyString(value, "file");
  if (isAbsolute(file)) {
    throw new Error(`"file" must be source-relative, not absolute: ${file}`);
  }
  if (/^[a-zA-Z]:[\\/]/u.test(file) || file.startsWith("\\\\")) {
    throw new Error(`"file" must be source-relative, not absolute: ${file}`);
  }
  const slashNormalized = file.replace(/\\/gu, "/");
  if (slashNormalized.split("/").includes("..")) {
    throw new Error(`"file" must not contain traversal segments: ${file}`);
  }
  const normalized = posix.normalize(slashNormalized);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === "." ||
    normalized.startsWith("/")
  ) {
    throw new Error(`"file" must not escape its source: ${file}`);
  }
  previewKind(normalized);
  return normalized;
}

export function resolveContainedPreviewPath(rootPath: string, relativeFile: string): string {
  const root = resolve(rootPath);
  const absolute = resolve(root, relativeFile);
  const relativePath = relative(root, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`"file" must not escape its source: ${relativeFile}`);
  }
  return absolute;
}

export function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}
