import type { useSdk } from "@get-bb/plugin-sdk/app";

export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const LEASE_TTL_MS = 3_600_000;
/** A reused lease must outlive the media downloads it serves, even on a slow link. */
const LEASE_REUSE_MARGIN_MS = 600_000;

type Sdk = ReturnType<typeof useSdk>;
type Lease = { baseUrl: string; expiresAtMs: number };

// Each lease mints a fresh URL. Reusing a directory's lease keeps HTML media
// URLs stable, so reopening a preview revalidates cached media instead of
// downloading it again. Markdown images render in bb's page, where the browser
// reuses a displayed image by URL without revalidating, so Markdown always
// takes a fresh lease. Leases belong to the bb server behind an SDK client.
const leases = new WeakMap<Sdk, Map<string, Lease>>();

const lasts = (lease: Lease | null | undefined): lease is Lease =>
  !!lease && lease.expiresAtMs - Date.now() >= LEASE_REUSE_MARGIN_MS;

/** A cached lease for this directory that the server still honors, or null. */
async function reusableLease(
  cached: Lease | undefined,
  name: string,
  signal?: AbortSignal,
): Promise<Lease | null> {
  if (!lasts(cached)) return null;
  // A bb server restart forgets every lease.
  const response = await fetch(`${cached.baseUrl}/${encodeURIComponent(name)}`, {
    method: "HEAD",
    credentials: "same-origin",
    redirect: "error",
    signal,
  }).catch(() => null);
  return response?.ok ? cached : null;
}

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
  sdk: Sdk,
  threadId: string,
  value: string,
  signal?: AbortSignal,
): Promise<Preview> {
  const { file, directory, name, kind } = parsePreviewFile(value);
  const { hostId } = await sdk.threads.storageLocation({ threadId, signal });
  const cache = leases.get(sdk) ?? new Map<string, Lease>();
  leases.set(sdk, cache);
  const leaseKey = `${hostId}\n${directory}`;
  const [result, reused] = await Promise.all([
    sdk.files.read({ path: file, rootPath: directory, hostId, signal }).catch((error: unknown) => {
      if (httpStatus(error) === 404)
        throw new Error(`Preview file not found: ${file}`, { cause: error });
      throw error;
    }),
    kind === "html" ? reusableLease(cache.get(leaseKey), name, signal) : null,
  ]);
  if (result.contentEncoding !== "utf8") {
    throw new Error(`Preview file is not valid UTF-8 text (encoding=${result.contentEncoding}).`);
  }
  if (result.sizeBytes > MAX_PREVIEW_BYTES) {
    throw new Error(
      `Preview file is too large (${result.sizeBytes} bytes; max ${MAX_PREVIEW_BYTES}).`,
    );
  }
  // The read can outlast the lease, for example in a suspended tab.
  const lease = lasts(reused)
    ? reused
    : await sdk.files.createPreview({ hostId, rootPath: directory, ttlMs: LEASE_TTL_MS, signal });
  cache.set(leaseKey, { baseUrl: lease.baseUrl, expiresAtMs: lease.expiresAtMs });
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
