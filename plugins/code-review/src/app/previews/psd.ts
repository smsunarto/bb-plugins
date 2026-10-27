/*
 * The flattened image a Photoshop file stores after its layers, the
 * "maximize compatibility" composite. Enough to compare two versions of a
 * texture without a Photoshop library: RGB, grayscale, and CMYK, 8 or 16 bits
 * per channel, raw or PackBits. Layers are skipped, never decoded.
 */

export class PsdError extends Error {}

type Image = { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };

export function decodePsd(buffer: ArrayBuffer): Image {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let at = 0;
  const u16 = () => {
    const value = view.getUint16(at);
    at += 2;
    return value;
  };
  const u32 = () => {
    const value = view.getUint32(at);
    at += 4;
    return value;
  };
  if (bytes.length < 26 || String.fromCharCode(...bytes.subarray(0, 4)) !== "8BPS") {
    throw new PsdError("Not a Photoshop file.");
  }
  at = 4;
  const version = u16();
  if (version !== 1 && version !== 2) throw new PsdError("Unknown Photoshop file version.");
  const large = version === 2;
  at += 6;
  const channels = u16();
  const height = u32();
  const width = u32();
  const depth = u16();
  const mode = u16();
  if (depth !== 8 && depth !== 16)
    throw new PsdError(`${depth}-bit Photoshop files are not supported.`);
  if (![1, 3, 4].includes(mode))
    throw new PsdError("Only RGB, grayscale, and CMYK files are supported.");
  if (width * height > 8192 * 8192) throw new PsdError("The image is too large to preview.");
  // Color mode data, image resources, and layers: each a length, then that many bytes, skipped.
  const skip = (wide: boolean) => {
    const length = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
    at += (wide ? 8 : 4) + length;
  };
  skip(false);
  skip(false);
  skip(large);
  const compression = u16();
  const sample = depth / 8;
  const plane = width * height;
  const planes: Uint8Array[] = [];
  const used = Math.min(channels, mode === 4 ? 5 : mode === 3 ? 4 : 2);
  if (compression === 0) {
    for (let channel = 0; channel < used; channel++) {
      const out = new Uint8Array(plane);
      for (let i = 0; i < plane; i++) out[i] = bytes[at + i * sample]!;
      planes.push(out);
      at += plane * sample;
    }
  } else if (compression === 1) {
    const counts: number[] = [];
    for (let row = 0; row < channels * height; row++) counts.push(large ? u32() : u16());
    for (let channel = 0; channel < used; channel++) {
      const rowBytes = width * sample;
      const raw = new Uint8Array(rowBytes * height);
      for (let row = 0; row < height; row++) {
        const end = at + counts[channel * height + row]!;
        let out = row * rowBytes;
        const stop = out + rowBytes;
        while (at < end && out < stop) {
          const header = (bytes[at++]! << 24) >> 24;
          if (header >= 0) {
            const run = Math.min(header + 1, stop - out);
            raw.set(bytes.subarray(at, at + run), out);
            at += header + 1;
            out += run;
          } else if (header !== -128) {
            const run = Math.min(1 - header, stop - out);
            raw.fill(bytes[at++]!, out, out + run);
            out += run;
          }
        }
        at = end;
      }
      const out = new Uint8Array(plane);
      for (let i = 0; i < plane; i++) out[i] = raw[i * sample]!;
      planes.push(out);
    }
  } else {
    throw new PsdError("This Photoshop file's compression is not supported.");
  }
  const data = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i++) {
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (mode === 3) {
      [r, g, b] = [planes[0]![i]!, planes[1]![i]!, planes[2]![i]!];
      if (planes[3]) a = planes[3][i]!;
    } else if (mode === 1) {
      r = g = b = planes[0]![i]!;
      if (planes[1]) a = planes[1][i]!;
    } else {
      // Photoshop stores CMYK inverted: 255 is no ink.
      const k = planes[3]![i]! / 255;
      [r, g, b] = [planes[0]![i]! * k, planes[1]![i]! * k, planes[2]![i]! * k];
      if (planes[4]) a = planes[4][i]!;
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width, height, data };
}
