import { createRequire } from "node:module";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { afterEach, expect, test, vi } from "vitest";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/document.ts";

vi.mock("node:module", () => ({ createRequire: vi.fn() }));
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
const noNative = async () => {
  vi.mocked(createRequire).mockImplementation(
    () =>
      (() => {
        throw new Error("native sharp missing");
      }) as never,
  );
  return (await import("./vendor/review/src/review-api/image-decode.ts")).decodeImage;
};

test("the bounded PNG/JPEG fallback preserves valid raster images when native sharp is absent", async () => {
  const decode = await noNative();
  const data = Buffer.from([0, 255, 0, 255]);
  const png = PNG.sync.write({ width: 1, height: 1, data } as PNG);
  const decoded = PNG.sync.read(await decode(png));
  expect({ width: decoded.width, height: decoded.height, data: decoded.data }).toEqual({
    width: 1,
    height: 1,
    data,
  });
  const jpg = jpeg.encode({ width: 1, height: 1, data }, 90).data;
  const fromJpeg = PNG.sync.read(await decode(jpg));
  expect([fromJpeg.width, fromJpeg.height]).toEqual([1, 1]);
  expect(fromJpeg.data[1]).toBeGreaterThan(240);
});

test("fallback refuses corruption, animated PNG and image dimensions above20megapixels", async () => {
  const decode = await noNative();
  const huge = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(huge);
  huge.writeUInt32BE(5000, 16);
  huge.writeUInt32BE(5000, 20);
  const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) } as PNG);
  const acTL = Buffer.alloc(20);
  acTL.writeUInt32BE(8, 0);
  acTL.write("acTL", 4);
  const animated = Buffer.concat([png.subarray(0, 33), acTL, png.subarray(33)]);
  for (const bytes of [huge, animated, Buffer.from("invalid")])
    await expect(decode(bytes)).rejects.toEqual(
      new ReviewInputError(
        "Provide a valid single PNG, JPEG, or WebP image (at most 20 megapixels).",
      ),
    );
});
