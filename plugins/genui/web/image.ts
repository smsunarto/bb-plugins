// What a fetched body really is. A server's Content-Type is a claim; the
// bytes decide which image type the page is told to decode.

/** Image types the proxy passes on, by MIME type. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"] as const;

export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

function startsWith(body: Uint8Array, bytes: readonly number[], at = 0): boolean {
  return body.length >= at + bytes.length && bytes.every((byte, index) => body[at + index] === byte);
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

const SVG_START = /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i;

/** The image type `body` holds, from its leading bytes; null when it is not one of IMAGE_MIME_TYPES. */
export function sniffImage(body: Uint8Array): ImageMime | null {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(body, ascii("GIF87a")) || startsWith(body, ascii("GIF89a"))) return "image/gif";
  if (startsWith(body, ascii("RIFF")) && startsWith(body, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(body, ascii("ftyp"), 4) && (startsWith(body, ascii("avif"), 8) || startsWith(body, ascii("avis"), 8))) {
    return "image/avif";
  }
  const head = new TextDecoder("utf-8", { fatal: false }).decode(body.subarray(0, 4096)).replace(/^\uFEFF/, "").trimStart();
  return SVG_START.test(head) ? "image/svg+xml" : null;
}

/** True when a Content-Type header names an image type (parameters ignored). */
export function declaresImage(contentType: string | undefined): boolean {
  return contentType !== undefined && /^image\/[a-z0-9.+-]+\s*(;|$)/i.test(contentType.trim());
}
