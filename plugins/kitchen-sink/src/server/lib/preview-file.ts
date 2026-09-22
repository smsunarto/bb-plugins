import { posix, win32 } from "node:path";

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

export function previewPathApi(file: string) {
  return /^[a-z]:[\\/]|^\\\\/iu.test(file) ? win32 : posix;
}

export function requireAbsolutePreviewFile(value: unknown): string {
  const file = requireNonEmptyString(value, "file");
  const path = previewPathApi(file);
  if (!path.isAbsolute(file) || file.includes("\0")) {
    throw new Error('"file" must be an absolute path on the thread host.');
  }
  const normalized = path.normalize(file);
  previewKind(normalized);
  return normalized;
}

export function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}
