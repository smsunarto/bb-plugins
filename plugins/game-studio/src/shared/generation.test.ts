import { expect, test } from "bun:test";
import { mediaRequest, normalizeMediaRequest } from "./generation.ts";
test("model defaults and supported alternatives reflect the enabled providers", () => {
  expect(
    normalizeMediaRequest(mediaRequest.parse({ kind: "image", prompt: "Icon" })).model,
  ).toEqual({ provider: "google", id: "gemini-nano-banana-2.1" });
  expect(
    normalizeMediaRequest(mediaRequest.parse({ kind: "video", prompt: "Coin" })).model.id,
  ).toBe("gemini-omni-1.1-flash");
  expect(
    normalizeMediaRequest(
      mediaRequest.parse({ kind: "video", prompt: "Coin", model: { provider: "fal" } }),
    ),
  ).toMatchObject({ resolution: "768p" });
  expect(() =>
    normalizeMediaRequest(
      mediaRequest.parse({
        kind: "image",
        prompt: "Icon",
        model: { provider: "openai", id: "gpt-image-2" },
      }),
    ),
  ).toThrow("does not support");
});
test("provider constraints prevent hidden batches, unsupported alpha, and unsafe paths", () => {
  for (const prompt of ["Icon --repeat 8", "{red,green,blue} icon"])
    expect(() =>
      normalizeMediaRequest(
        mediaRequest.parse({ kind: "image", prompt, model: { provider: "midjourney" } }),
      ),
    ).toThrow("plain creative brief");
  expect(() =>
    normalizeMediaRequest(
      mediaRequest.parse({ kind: "image", prompt: "Icon", transparentBackground: true }),
    ),
  ).toThrow("alpha transparency");
  expect(
    mediaRequest.safeParse({ kind: "model-3d", approvedImagePath: "../outside.png" }).success,
  ).toBe(false);
  expect(
    mediaRequest.safeParse({ kind: "model-3d", approvedImagePath: "C:\\outside.png" }).success,
  ).toBe(false);
  expect(() =>
    normalizeMediaRequest(
      mediaRequest.parse({
        kind: "video",
        prompt: "Coin",
        model: { provider: "fal" },
        resolution: "720p",
      }),
    ),
  ).toThrow("not supported");
});
