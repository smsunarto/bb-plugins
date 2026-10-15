import { z } from "zod";

export const generationId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const mediaPath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a project-relative file path without parent segments.",
  );
const model = z.strictObject({
  provider: z.string().min(1).max(80),
  id: z.string().min(1).max(100).optional(),
});
const brief = z.string().trim().min(1).max(12000);
const imageReferenceKey = z
  .string()
  .min(1)
  .max(32000, {
    message: "Image reference labels exceed 32,000 characters. Shorten names or remove aliases.",
  })
  .optional();
export const imageRequest = z.strictObject({
  kind: z.literal("image"),
  prompt: brief,
  model: model.default({ provider: "google", id: "gemini-nano-banana-2.1" }),
  images: z.array(mediaPath).max(14).default([]),
  imageReferenceKey,
  outputCount: z.union([z.literal(1), z.literal(4)]).optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).default("1:1"),
  transparentBackground: z.boolean().default(false),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
});
export const textRequest = z.strictObject({
  kind: z.literal("text"),
  prompt: brief,
  model: model.default({ provider: "bb" }),
  providerId: z.string().min(1).max(100).optional(),
  images: z.array(mediaPath).max(14).default([]),
  imageReferenceKey,
  outputCount: z.literal(1).default(1),
});
export const videoRequest = z.strictObject({
  kind: z.literal("video"),
  prompt: brief,
  model: model.default({ provider: "google", id: "gemini-omni-1.1-flash" }),
  imagePath: mediaPath.optional(),
  endImagePath: mediaPath.optional(),
  outputCount: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
  duration: z.number().int().min(3).max(15).default(5),
  resolution: z.enum(["360p", "480p", "720p", "768p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
  motion: z.enum(["low", "high"]).default("low"),
  loop: z.boolean().default(false),
});
export const modelRequest = z.strictObject({
  kind: z.literal("model-3d"),
  model: model.default({ provider: "tripo", id: "tripo-p2" }),
  approvedImagePath: mediaPath,
  outputCount: z.literal(1).default(1),
  targetPolycount: z.number().int().min(1000).max(200000).default(20000),
});
export const mediaRequest = z.discriminatedUnion("kind", [
  imageRequest,
  textRequest,
  videoRequest,
  modelRequest,
]);
export type MediaRequest = z.output<typeof mediaRequest>;
export const generationTarget = z.strictObject({
  boardId: generationId,
  nodeId: generationId,
  fingerprint: z.string(),
});
export const generatedOutput = z.strictObject({
  path: mediaPath,
  type: z.enum(["image", "video", "model", "text"]),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const generationJob = z.strictObject({
  version: z.literal(1),
  id: generationId,
  threadId: z.string().nullable(),
  origin: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("agent") }),
      z.strictObject({ kind: z.literal("canvas"), gameId: generationId }),
    ])
    .default({ kind: "agent" }),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "uncertain",
    "auth-required",
  ]),
  request: mediaRequest,
  target: generationTarget.optional(),
  taskId: z.string().max(200).optional(),
  cancelRequested: z.boolean().optional(),
  providerData: z.record(z.string(), z.string()).optional(),
  detail: z.string().max(2000).optional(),
  outputs: z.array(generatedOutput).max(20),
});
export type GenerationJob = z.output<typeof generationJob>;
export const startGenerationInput = z.strictObject({
  gameId: generationId,
  requestId: generationId,
  request: mediaRequest,
});
export const canvasGenerationInput = z.strictObject({
  gameId: generationId,
  requestId: generationId,
  boardId: generationId,
  nodeId: generationId,
  revision: z.string().min(1),
  model: model.optional(),
  approvedImagePath: mediaPath.optional(),
  textProviderId: z.string().min(1).max(100).optional(),
});
export const generationControlInput = z.strictObject({
  gameId: generationId,
  jobId: generationId,
  action: z.enum(["status", "resume", "cancel"]).default("status"),
});
export const providerCapabilities = [
  {
    provider: "midjourney",
    models: ["default"],
    kinds: ["image", "video"],
    imageOutputs: [4],
    videoOutputs: [1, 2, 4],
    transparency: false,
  },
  {
    provider: "google",
    models: ["gemini-nano-banana-2.1", "gemini-omni-1.1-flash"],
    kinds: ["image", "video"],
    imageOutputs: [1],
    videoOutputs: [1],
    transparency: false,
  },
  {
    provider: "fal",
    models: ["minimax/h3-max/reference-to-video"],
    kinds: ["video"],
    imageOutputs: [],
    videoOutputs: [1],
    transparency: false,
  },
  {
    provider: "tripo",
    models: ["tripo-p2"],
    kinds: ["model-3d"],
    imageOutputs: [],
    videoOutputs: [],
    transparency: false,
  },
] as const;

/** Provider policy belongs here, not in agent-authored CLI flags. */
export function normalizeMediaRequest(request: MediaRequest): MediaRequest {
  if (request.kind === "text") {
    if (request.model.provider !== "bb")
      throw new Error("Text generation uses the selected BB provider.");
    return request;
  }
  const provider = providerCapabilities.find((item) => item.provider === request.model.provider);
  if (!provider || !provider.kinds.some((kind) => kind === request.kind))
    throw new Error(`Provider ${request.model.provider} does not support ${request.kind}.`);
  if (request.model.id && !provider.models.some((id) => id === request.model.id))
    throw new Error(`Model ${request.model.id} is not supported by ${provider.provider}.`);
  return policies[provider.provider](request);
}
const policies: Record<
  (typeof providerCapabilities)[number]["provider"],
  (request: MediaRequest) => MediaRequest
> = {
  midjourney: normalizeMidjourney,
  google: normalizeGoogle,
  fal: normalizeFal,
  tripo: (request) => request,
};
function normalizeMidjourney(request: MediaRequest): MediaRequest {
  if (request.kind === "model-3d" || request.kind === "text")
    throw new Error("Midjourney supports only images and video.");
  const promptParts = [
    request.prompt,
    ...(request.kind === "image" && request.imageReferenceKey ? [request.imageReferenceKey] : []),
  ];
  if (promptParts.some((part) => /(?:^|\s)--[a-z]|\{[^{}]*,[^{}]*\}/i.test(part)))
    throw new Error("Use a plain creative brief. Put generation settings in the tool parameters.");
  if (request.kind === "image") {
    if (request.outputCount !== undefined && request.outputCount !== 4)
      throw new Error(
        "Midjourney standard images produce four candidates per job. Use outputCount: 4.",
      );
    if (request.transparentBackground)
      throw new Error("Midjourney does not produce transparent backgrounds.");
    return { ...request, outputCount: 4 };
  }
  if (request.loop && request.endImagePath)
    throw new Error("Choose a loop or an end frame, not both.");
  if (
    !request.imagePath ||
    request.duration !== 5 ||
    (request.resolution && !["480p", "720p"].includes(request.resolution))
  )
    throw new Error(
      "Midjourney video needs a start image, five seconds, and 480p or 720p resolution.",
    );
  return { ...request, resolution: request.resolution ?? "720p" };
}
function normalizeGoogle(request: MediaRequest): MediaRequest {
  if (request.kind === "image") {
    if (request.outputCount !== undefined && request.outputCount !== 1)
      throw new Error("Nano Banana 2.1 generates one output per request.");
    if (request.model.id && request.model.id !== "gemini-nano-banana-2.1")
      throw new Error("Use gemini-nano-banana-2.1 for Google image generation.");
    if (request.transparentBackground)
      throw new Error(
        "This model does not guarantee alpha transparency. Generate an opaque source for a separate cutout step.",
      );
    return { ...request, outputCount: 1 };
  }
  if (request.kind !== "video") throw new Error("Google does not support 3D geometry.");
  if ((request.model.id && request.model.id !== "gemini-omni-1.1-flash") || request.duration > 10)
    throw new Error("Use Gemini Omni 1.1 Flash with a duration from three to ten seconds.");
  return normalizeVideo(request, "720p", ["360p", "720p", "1080p", "4k"]);
}
function normalizeFal(request: MediaRequest): MediaRequest {
  if (request.kind !== "video") throw new Error("H3 Max generates video.");
  return normalizeVideo(request, "768p", ["480p", "768p", "1080p"]);
}
function normalizeVideo(
  request: z.output<typeof videoRequest>,
  fallback: z.output<typeof videoRequest>["resolution"],
  resolutions: string[],
): MediaRequest {
  if (request.outputCount !== 1)
    throw new Error("This video model generates one output per request.");
  if (request.loop) throw new Error("This video adapter does not support a loop parameter.");
  if (request.endImagePath && !request.imagePath)
    throw new Error("An end image also needs a start image.");
  const resolution = request.resolution ?? fallback;
  if (!resolution || !resolutions.includes(resolution))
    throw new Error(`Resolution ${resolution} is not supported by this video model.`);
  return { ...request, resolution };
}

export const canvasDirectInput = canvasGenerationInput.extend({
  threadId: z.string().nullable(),
});
export const canvasDirectControl = generationControlInput.extend({
  threadId: z.string().nullable(),
});
