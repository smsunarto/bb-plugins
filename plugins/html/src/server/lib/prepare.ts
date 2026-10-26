/**
 * Turns an agent's page into the stored page: rejects viewport-height units
 * and inlines local images. Ported from T3 Code's `HtmlRender.ts`; images come
 * from the thread's machine. Its runtime is added where it is shown, with that
 * viewer's theme.
 */

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_PAGE_BYTES = 25 * MIB;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

export class HtmlRenderPageError extends Error {
  override readonly name = "HtmlRenderPageError";
}

export function imagesNotFoundError(paths: readonly string[]) {
  return new HtmlRenderPageError(
    `These local images could not be read: ${paths.join(", ")}. Use absolute paths to existing image files, or remove them.`,
  );
}

export const imageTooLargeError = (path: string, sizeBytes: number) =>
  new HtmlRenderPageError(
    `${path} is ${formatMib(sizeBytes)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`,
  );

const pageTooLargeError = (sizeBytes: number) =>
  new HtmlRenderPageError(
    `With its images inlined the page is ${formatMib(sizeBytes)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`,
  );

// Check only stylesheets and style attributes, even inside scripts; skip comments whole.
// Consume unclosed comments, tags, or quotes through EOF to keep both patterns linear.
const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

export function rejectViewportHeight(html: string): void {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const css = sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const found = VIEWPORT_HEIGHT_UNIT.exec(css)?.[0];
    if (found !== undefined) {
      throw new HtmlRenderPageError(
        `The page uses a viewport height unit (${found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`,
      );
    }
  }
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

function findLocalImages(html: string) {
  return Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });
}

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

// Validate bytes, not filenames, so renamed files or symlinks cannot inline secrets.
export function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

function hasSvgRoot(text: string): boolean {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
}

function afterDoctype(text: string, from: number): number {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
}

/**
 * Reads one file from the thread's machine; undefined when it cannot be read.
 * Throws `HtmlRenderPageError` for a file the agent must change, such as one over the size limit.
 */
export type ReadLocalFile = (path: string) => Promise<Uint8Array | undefined>;

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

export async function inlineLocalImages(
  html: string,
  readFile: ReadLocalFile,
): Promise<{ html: string; missing: string[] }> {
  const references = findLocalImages(html);
  const paths = [...new Set(references.map((reference) => reference.path))];
  // Reads are bounded per file by the host; stop once accumulated images cannot fit.
  let readBytes = 0;
  const images = await mapLimit(paths, 4, async (path) => {
    const bytes = await readFile(filePathFor(path)).catch((error: unknown) => {
      if (error instanceof HtmlRenderPageError) throw error;
      return undefined;
    });
    if (bytes === undefined || !isImageBytes(bytes)) return undefined;
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw imageTooLargeError(path, bytes.byteLength);
    readBytes += Math.ceil(bytes.byteLength / 3) * 4;
    if (readBytes > MAX_PAGE_BYTES) throw pageTooLargeError(readBytes);
    return { path, dataUri: dataUriPrefix(path) + Buffer.from(bytes).toString("base64") };
  });
  const dataUris = new Map(
    images.flatMap((image) => (image ? [[image.path, image.dataUri] as const] : [])),
  );
  // Every reference repeats its image, so bound the expanded page before building it.
  const expandedBytes = references.reduce((total, reference) => {
    const dataUri = dataUris.get(reference.path);
    return dataUri === undefined
      ? total
      : total + dataUri.length - Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (expandedBytes > MAX_PAGE_BYTES) throw pageTooLargeError(expandedBytes);
  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  return { html: parts.join(""), missing: paths.filter((path) => !dataUris.has(path)) };
}

export async function preparePage(html: string, readFile: ReadLocalFile) {
  rejectViewportHeight(html);
  return inlineLocalImages(html, readFile);
}
