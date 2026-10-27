import { parseBlobQuery } from "../../shared/blob-url.ts";
import { contentTypeOf } from "../../shared/previews.ts";
import { BlobError, type BlobReader, type RangeRequest } from "./blobs.ts";
import { GhError } from "./gh.ts";

/*
 * `GET /blob`: one side of one changed file, for `<img>`, `<video>`, model
 * loaders, and fonts. The file is repository content, so it is served as an
 * inert download: never sniffed, sandboxed if opened as a page, and never
 * embeddable by another site.
 */

const ERROR_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function failure(status: number, message: string): Response {
  return new Response(message, { status, headers: ERROR_HEADERS });
}

/**
 * Another site's page can embed this URL, and a no-cors request carries no
 * Origin for bb's own check to refuse. Browsers say where it came from.
 */
export function fromAnotherSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

/**
 * A single `Range: bytes=…` request, which media elements send to seek and
 * WebKit needs before it plays a video at all. Anything else reads the whole file.
 */
export function rangeOf(header: string | null): RangeRequest | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") return { suffix: Number(match[2]) };
  return { start: Number(match[1]), end: match[2] === "" ? null : Number(match[2]) };
}

export async function serveBlob(blobs: BlobReader, request: Request): Promise<Response> {
  if (fromAnotherSite(request)) return failure(403, "Previews load only inside bb.");
  const url = new URL(request.url);
  const parsed = parseBlobQuery((name) => url.searchParams.get(name) ?? undefined);
  if (!parsed) return failure(400, "That is not a file in a review.");
  try {
    const content = await blobs.open(parsed, request.signal, rangeOf(request.headers.get("range")));
    const name = parsed.path.split("/").at(-1) ?? "file";
    const { range } = content;
    return new Response(content.body, {
      status: range ? 206 : 200,
      headers: {
        "content-type": contentTypeOf(parsed.path),
        "content-length": String(range ? range.end - range.start + 1 : content.size),
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${content.size}` } : {}),
        // The URL names commits, so the bytes behind it never change.
        "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        ...(content.lfs ? { "x-lfs-oid": content.lfs.oid } : {}),
      },
    });
  } catch (error) {
    if (request.signal.aborted) return failure(499, "The preview was closed.");
    if (error instanceof BlobError) return failure(error.status, error.message);
    if (error instanceof GhError) {
      return failure(error.code === "not-found" ? 404 : 503, error.message);
    }
    return failure(502, error instanceof Error ? error.message : String(error));
  }
}
