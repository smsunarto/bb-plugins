import { expect, test } from "bun:test";
import { declaredSize, decodeImage } from "./decode.ts";

function tga(width: number, height: number): ArrayBuffer {
  const header = new DataView(new ArrayBuffer(18));
  header.setUint8(2, 10); // RLE true color: a huge image in a tiny file
  header.setUint16(12, width, true);
  header.setUint16(14, height, true);
  header.setUint8(16, 32);
  return header.buffer;
}

function exr(width: number, height: number): ArrayBuffer {
  const parts: number[] = [0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0];
  const attribute = (name: string, type: string, value: number[]) => {
    parts.push(...new TextEncoder().encode(`${name}\0${type}\0`));
    const size = new DataView(new ArrayBuffer(4));
    size.setUint32(0, value.length, true);
    parts.push(...new Uint8Array(size.buffer), ...value);
  };
  attribute("compression", "compression", [0]);
  const box = new DataView(new ArrayBuffer(16));
  box.setInt32(8, width - 1, true);
  box.setInt32(12, height - 1, true);
  attribute("dataWindow", "box2i", [...new Uint8Array(box.buffer)]);
  parts.push(0);
  return new Uint8Array(parts).buffer;
}

function tiff(width: number, height: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(8 + 2 + 2 * 12 + 4));
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 2, true);
  view.setUint16(10, 256, true);
  view.setUint16(12, 3, true);
  view.setUint32(14, 1, true);
  view.setUint16(18, width, true);
  view.setUint16(22, 257, true);
  view.setUint16(24, 4, true);
  view.setUint32(26, 1, true);
  view.setUint32(30, height, true);
  return view.buffer;
}

test("each decoded format's size is read from its header alone", () => {
  expect(declaredSize("tga", tga(640, 480))).toEqual({ width: 640, height: 480 });
  expect(declaredSize("exr", exr(2048, 1024))).toEqual({ width: 2048, height: 1024 });
  expect(declaredSize("tiff", tiff(300, 200))).toEqual({ width: 300, height: 200 });
  const hdr = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 512 +X 1024\n");
  expect(declaredSize("hdr", hdr.buffer)).toEqual({ width: 1024, height: 512 });
  expect(declaredSize("exr", new ArrayBuffer(3))).toBeNull();
});

test("a small file that declares a huge image is refused before anything decodes", async () => {
  await expect(decodeImage("code-review", "tga", tga(16384, 16384))).rejects.toThrow(
    "16384 × 16384, too large",
  );
  await expect(decodeImage("code-review", "exr", exr(8192, 8192))).rejects.toThrow("too large");
});
