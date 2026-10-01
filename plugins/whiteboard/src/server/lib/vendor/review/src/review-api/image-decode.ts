// Vendored from dev.fast review/src/review-api/image-decode.ts @4ecc570 (MIT).
import { createRequire } from "node:module";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { ReviewInputError } from "../../../../../../shared/vendor/review/src/review-api/document.ts";

const PIXEL_LIMIT = 20_000_000;
const INVALID_IMAGE = "Provide a valid single PNG, JPEG, or WebP image (at most 20 megapixels).";
type Sharp = (bytes: Buffer, options: {limitInputPixels: number; failOn: string}) => {
  metadata(): Promise<{format?: string; pages?: number}>;
  png(): {toBuffer(): Promise<Buffer>};
};

/** Optional native decoder. A missing platform library never prevents engine startup. */
function nativeDecoder(): Sharp | undefined {
  try {
    // bb preserves source module location for cached CJS. Packaged ESM uses its bundle URL.
    const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
    return require("sharp") as Sharp;
  } catch {
    return undefined;
  }
}

function decodePng(bytes: Buffer): Buffer {
  if (bytes.length < 24) throw new Error("Invalid PNG");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > PIXEL_LIMIT) throw new Error("Image too large");
  // pngjs decodes the first frame. Refuse APNG rather than silently retaining one frame.
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) throw new Error("Invalid PNG chunk");
    if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") throw new Error("Animated PNG");
    offset += length + 12;
  }
  const image = PNG.sync.read(bytes, {checkCRC: true});
  return PNG.sync.write(image);
}

/** The upstream contract: bounded, single frame, re-encoded as PNG. */
export async function decodeImage(bytes: Uint8Array): Promise<Buffer> {
  // Electron's Linux GLib conflicts with Sharp's bundled native library.
  if (process.platform === "linux" && process.versions.electron)
    throw new ReviewInputError("Image uploads and imports are unavailable in Review Desktop on Linux.");
  try {
    const input = Buffer.from(bytes);
    const sharp = nativeDecoder();
    if (sharp) {
      const decoder = sharp(input, {limitInputPixels: PIXEL_LIMIT, failOn: "warning"});
      const metadata = await decoder.metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1)
        throw new Error("Unsupported image");
      return await decoder.png().toBuffer();
    }
    if (input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return decodePng(input);
    if (input[0] === 0xff && input[1] === 0xd8) {
      const image = jpeg.decode(input, {useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 20, maxMemoryUsageInMB: 256});
      return PNG.sync.write({width: image.width, height: image.height, data: Buffer.from(image.data)} as PNG);
    }
    throw new Error("Unsupported image");
  } catch {
    throw new ReviewInputError(INVALID_IMAGE);
  }
}
