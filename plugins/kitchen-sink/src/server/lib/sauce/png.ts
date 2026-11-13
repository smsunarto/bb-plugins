import { promisify } from "node:util";
import { inflate } from "node:zlib";

const inflateAsync = promisify(inflate);

/** PNG width and height from the IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Box-averaged 8-bit grayscale thumbnail of a PNG, decoded in process so measuring
 * the screen's rotation needs no ImageMagick on the bb server (macOS has none by default). Handles the 8-bit,
 * non-interlaced gray, RGB, and RGBA images device screenshots use; returns null
 * for anything else.
 */
export async function pngGrayThumbnail(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array | null> {
  const size = pngSize(bytes);
  if (!size) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const depth = bytes[24];
  const colorType = bytes[25] ?? -1;
  const interlace = bytes[28];
  const channels = CHANNELS[colorType];
  if (depth !== 8 || interlace !== 0 || !channels) return null;

  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  let raw: Uint8Array;
  try {
    // Inflating off the event loop leaves only the ~50 ms unfilter pass on it.
    raw = await inflateAsync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = size.width * channels;
  if (raw.length < size.height * (stride + 1)) return null;
  const sums = new Float64Array(width * height);
  const counts = new Uint32Array(width * height);
  const column = new Uint32Array(size.width);
  for (let x = 0; x < size.width; x += 1)
    column[x] = Math.min(width - 1, Math.floor((x * width) / size.width));
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < size.height; y += 1) {
    const offset = y * (stride + 1);
    unfilter(
      raw[offset] ?? 0,
      raw.subarray(offset + 1, offset + 1 + stride),
      previous,
      row,
      channels,
    );
    const base = Math.min(height - 1, Math.floor((y * height) / size.height)) * width;
    for (let x = 0, p = 0; x < size.width; x += 1, p += channels) {
      const gray =
        channels >= 3 ? 0.299 * row[p]! + 0.587 * row[p + 1]! + 0.114 * row[p + 2]! : row[p]!;
      const cell = base + column[x]!;
      sums[cell]! += gray;
      counts[cell]! += 1;
    }
    [previous, row] = [row, previous];
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round((sums[i] ?? 0) / (counts[i] || 1));
  return out;
}

/** Reverses one scanline's PNG filter into `out`, given the previous decoded line. */
function unfilter(
  filter: number,
  line: Uint8Array,
  previous: Uint8Array,
  out: Uint8Array,
  bpp: number,
) {
  const n = line.length;
  if (filter === 0) {
    out.set(line);
    return;
  }
  for (let i = 0; i < n; i += 1) {
    const x = line[i]!;
    const a = i >= bpp ? out[i - bpp]! : 0;
    const b = previous[i]!;
    if (filter === 1) out[i] = (x + a) & 0xff;
    else if (filter === 2) out[i] = (x + b) & 0xff;
    else if (filter === 3) out[i] = (x + ((a + b) >> 1)) & 0xff;
    else if (filter === 4) {
      const c = i >= bpp ? previous[i - bpp]! : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      out[i] = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    } else out[i] = x;
  }
}
