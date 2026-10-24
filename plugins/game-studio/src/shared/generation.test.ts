import { expect, test } from "bun:test";
import { agentSelection, mediaRequest, normalizeMediaRequest } from "./generation.ts";
test("model defaults and supported alternatives reflect the enabled providers", () => {
  expect(
    normalizeMediaRequest(mediaRequest.parse({ kind: "image", prompt: "Icon" })).model,
  ).toEqual({ provider: "google", id: "gemini-nano-banana-2.1" });
  expect(
    normalizeMediaRequest(mediaRequest.parse({ kind: "video", prompt: "Coin" })).model.id,
  ).toBe("gemini-omni-1.1-flash-preview");
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

test("reference keys preserve the brief with a separate bounded metadata budget", () => {
  const request = mediaRequest.parse({
    kind: "image",
    prompt: "Keep Hero's shape and Palette's colors",
    images: ["hero.png", "palette.png"],
    imageReferenceKey: '1. ["Hero", "Shape study"]\n2. ["Palette"]',
  });
  expect(normalizeMediaRequest(request)).toMatchObject({
    images: ["hero.png", "palette.png"],
    imageReferenceKey: '1. ["Hero", "Shape study"]\n2. ["Palette"]',
    prompt: "Keep Hero's shape and Palette's colors",
  });
  expect(normalizeMediaRequest({ ...request, model: { provider: "midjourney" } })).toMatchObject({
    outputCount: 4,
    imageReferenceKey: '1. ["Hero", "Shape study"]\n2. ["Palette"]',
  });
  expect(() =>
    mediaRequest.parse({
      kind: "image",
      prompt: "A key",
      images: ["hero.png", "palette.png"],
      imageReferenceKey: "",
    }),
  ).toThrow();
  expect(() =>
    mediaRequest.parse({
      kind: "text",
      prompt: "Describe the key",
      images: ["hero.png"],
      imageReferenceKey: "x".repeat(32001),
    }),
  ).toThrow("Shorten names or remove aliases");
  expect(() =>
    normalizeMediaRequest(
      mediaRequest.parse({
        kind: "image",
        prompt: "A key",
        model: { provider: "midjourney" },
        images: ["hero.png"],
        imageReferenceKey: '1. ["Hero --repeat 8"]',
      }),
    ),
  ).toThrow("plain creative brief");
});

test("Tripo steps reject requests the provider cannot run", () => {
  const edit = (request: Record<string, unknown>) => () =>
    normalizeMediaRequest(
      mediaRequest.parse({ kind: "model-edit", sourcePath: "canvas/a.glb", ...request }),
    );
  expect(edit({ operation: "texture" })).toThrow("texture prompt or at least one reference view");
  expect(edit({ operation: "rig" })).toThrow("rig type");
  expect(edit({ operation: "animate", animation: "preset:idle" })).toThrow("rigged by a Tripo Rig");
  expect(edit({ operation: "pbr" })).not.toThrow();
  expect(edit({ operation: "smart-uv" })).not.toThrow();
  expect(edit({ operation: "apply-uv" })).toThrow("selected candidate");
  expect(
    edit({ operation: "texture", uvCandidateTaskId: "11111111-1111-4111-8111-111111111111" }),
  ).toThrow("Only Apply UV");
  expect(() =>
    mediaRequest.parse({
      kind: "model-edit",
      operation: "animate",
      sourcePath: "canvas/a.glb",
      animation: "idle --flag",
    }),
  ).toThrow("Tripo preset");
});
test("a pinned agent keeps its model's own reasoning level and service tier", () => {
  const agent = {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "ultracode",
    serviceTier: "ultrafast",
  };
  expect(agentSelection.parse(agent)).toEqual(agent);
  expect(agentSelection.safeParse({ ...agent, serviceTier: "" }).success).toBe(false);
  expect(agentSelection.safeParse({ ...agent, reasoningLevel: "" }).success).toBe(false);
});
