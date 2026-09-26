import type { useSdk } from "@get-bb/plugin-sdk/app";

export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const LEASE_TTL_MS = 3_600_000;

export type PreviewKind = "html" | "markdown";

const PREVIEW_KIND_BY_EXTENSION: ReadonlyMap<string, PreviewKind> = new Map([
  [".html", "html"],
  [".htm", "html"],
  [".md", "markdown"],
  [".markdown", "markdown"],
]);

type PreviewFields = { file: string; hostId: string; url: string; expiresAtMs: number };
export type Preview =
  | (PreviewFields & { kind: "html"; html: string })
  | (PreviewFields & { kind: "markdown"; content: string });

/** An absolute host path split the way the file API and preview lease need it. */
export interface PreviewFile {
  file: string;
  directory: string;
  name: string;
  kind: PreviewKind;
}

function previewKind(name: string, file: string): PreviewKind {
  const extension = /\.[^.]*$/u.exec(name)?.[0].toLowerCase() ?? "";
  const kind = PREVIEW_KIND_BY_EXTENSION.get(extension);
  if (kind === undefined) {
    throw new Error(
      `"file" must end with .html, .htm, .md, or .markdown, got ${JSON.stringify(file)}`,
    );
  }
  return kind;
}

/**
 * Parse an absolute POSIX, drive, or UNC path on the thread's host. This runs
 * in the browser, so it cannot lean on `node:path`. It normalizes `.`, `..`,
 * and repeated separators the way `path.normalize` does.
 */
export function parsePreviewFile(value: string): PreviewFile {
  const input = value.trim();
  if (!input) throw new Error('"file" must be a non-empty string');
  const windows = /^[a-z]:[\\/]|^\\\\/iu.test(input);
  if ((!windows && !input.startsWith("/")) || input.includes("\0")) {
    throw new Error('"file" must be an absolute path on the thread host.');
  }
  const separator = windows ? "\\" : "/";
  const raw = input.split(windows ? /[\\/]+/u : /\/+/u);
  // POSIX roots are "", drive roots are "C:", and UNC roots keep server and share.
  const rootLength = windows && input.startsWith("\\\\") ? 3 : 1;
  const root = rootLength === 3 ? `\\\\${raw[1]}${separator}${raw[2]}` : raw[0]!;
  const segments: string[] = [];
  for (const segment of raw.slice(rootLength)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const name = segments.at(-1);
  if (name === undefined) throw new Error('"file" must name a file on the thread host.');
  const file = `${root}${separator}${segments.join(separator)}`;
  return {
    file,
    directory: `${root}${separator}${segments.slice(0, -1).join(separator)}`,
    name,
    kind: previewKind(name, input),
  };
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}

/**
 * Read an absolute HTML or Markdown file on the thread's host and lease its
 * directory, so sibling assets load from the same host.
 */
export async function loadPreview(
  sdk: ReturnType<typeof useSdk>,
  threadId: string,
  value: string,
  signal?: AbortSignal,
): Promise<Preview> {
  const { file, directory, name, kind } = parsePreviewFile(value);
  const { hostId } = await sdk.threads.storageLocation({ threadId, signal });
  let result;
  try {
    result = await sdk.files.read({ path: file, rootPath: directory, hostId, signal });
  } catch (error) {
    if (httpStatus(error) === 404)
      throw new Error(`Preview file not found: ${file}`, { cause: error });
    throw error;
  }
  if (result.contentEncoding !== "utf8") {
    throw new Error(`Preview file is not valid UTF-8 text (encoding=${result.contentEncoding}).`);
  }
  if (result.sizeBytes > MAX_PREVIEW_BYTES) {
    throw new Error(
      `Preview file is too large (${result.sizeBytes} bytes; max ${MAX_PREVIEW_BYTES}).`,
    );
  }
  const lease = await sdk.files.createPreview({
    hostId,
    rootPath: directory,
    ttlMs: LEASE_TTL_MS,
    signal,
  });
  const fields = {
    file,
    hostId,
    url: `${lease.baseUrl}/${encodeURIComponent(name)}`,
    expiresAtMs: lease.expiresAtMs,
  };
  return kind === "markdown"
    ? { kind, ...fields, content: result.content }
    : { kind, ...fields, html: result.content };
}
