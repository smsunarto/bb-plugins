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
/** Media models whose prompts a BB model can write from a prompting guide. */
export const briefRecipe = z.enum(["nano-banana", "concept-art", "omni-video", "fal-video"]);
export type BriefRecipe = z.output<typeof briefRecipe>;
export const reasoningLevel = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);
export const serviceTier = z.enum(["default", "fast"]);
/** The BB agent a text node or a review runs on, as `experimental_ProviderModelPicker` resolves it. */
export const agentSelection = z.strictObject({
  providerId: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  reasoningLevel,
  serviceTier: serviceTier.optional(),
});
export type AgentSelection = z.output<typeof agentSelection>;
export const textRequest = z.strictObject({
  kind: z.literal("text"),
  prompt: brief,
  model: model.default({ provider: "bb" }),
  providerId: z.string().min(1).max(100).optional(),
  reasoningLevel: reasoningLevel.optional(),
  serviceTier: serviceTier.optional(),
  /** Writes the target media node's prompt for this model instead of text. */
  briefFor: briefRecipe.optional(),
  /** Reviews these outputs of the target node against the inputs they were made from. */
  reviewOf: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
  /** Chooses the best of these outputs of the target node, which then becomes its pick. */
  judgeOf: z.array(z.string().min(1).max(100)).min(2).max(12).optional(),
  /** The node's pick when the judge started; a judge never overrides a pick changed since. */
  judgePick: z.string().min(1).max(100).optional(),
  // A review sends a run's inputs and its outputs together.
  images: z.array(mediaPath).max(20).default([]),
  /** Project files the reviewer inspects on disk, such as 3D models. */
  files: z.array(mediaPath).min(1).max(8).optional(),
  imageReferenceKey,
  outputCount: z.literal(1).default(1),
});
export const videoRequest = z.strictObject({
  kind: z.literal("video"),
  prompt: brief,
  model: model.default({ provider: "google", id: "gemini-omni-1.1-flash-preview" }),
  imagePath: mediaPath.optional(),
  endImagePath: mediaPath.optional(),
  outputCount: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
  duration: z.number().int().min(3).max(15).default(5),
  resolution: z.enum(["360p", "480p", "720p", "768p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
  motion: z.enum(["low", "high"]).default("low"),
  loop: z.boolean().default(false),
});
export const modelViews = ["front", "left", "back", "right"] as const;
export const modelRequest = z.strictObject({
  kind: z.literal("model-3d"),
  model: model.default({ provider: "tripo", id: "tripo-p2" }),
  /** The front view. */
  approvedImagePath: mediaPath,
  /** Further views of the same subject; any of them makes this a multiview request. */
  views: z
    .strictObject({
      left: mediaPath.optional(),
      back: mediaPath.optional(),
      right: mediaPath.optional(),
    })
    .optional(),
  outputCount: z.literal(1).default(1),
  targetPolycount: z.number().int().min(1000).max(200000).default(20000),
});
/**
 * A visible BB thread that does a step's work with its own tools, such as Blender cleanup. It
 * reads the step's inputs from disk and writes what it makes into the run's staging directory.
 */
export const agentRequest = z.strictObject({
  kind: z.literal("agent"),
  prompt: brief,
  model: model.default({ provider: "bb" }),
  providerId: z.string().min(1).max(100).optional(),
  reasoningLevel: reasoningLevel.optional(),
  serviceTier: serviceTier.optional(),
  images: z.array(mediaPath).max(14).default([]),
  imageReferenceKey,
  /** Project files the agent works from, such as 3D models. */
  files: z.array(mediaPath).max(8).default([]),
  outputCount: z.literal(1).default(1),
});
/** Tripo's processing steps for an existing model, in pipeline order. */
export const modelOperations = ["texture", "pbr", "rig", "animate"] as const;
export const rigTypes = [
  "biped",
  "quadruped",
  "hexapod",
  "octopod",
  "avian",
  "serpentine",
  "aquatic",
] as const;
/** What a canvas Tripo node uses until its settings say otherwise; the inspector shows the same. */
export const modelEditDefaults = {
  textureQuality: "detailed",
  rigType: "biped",
  animation: "preset:idle",
} as const;
/** One Tripo processing step applied to a model a previous node made. */
export const modelEditRequest = z.strictObject({
  kind: z.literal("model-edit"),
  model: model.default({ provider: "tripo", id: "tripo-p2" }),
  operation: z.enum(modelOperations),
  /** The model to process. */
  sourcePath: mediaPath,
  /**
   * The Tripo task that made the source on the project's machine. Tripo processes tasks, not
   * files, so a source without one is imported first; an animation needs its rig's task.
   */
  sourceTaskId: z.string().min(1).max(200).optional(),
  /** Texturing references in front, left, back, right order. */
  views: z
    .strictObject({
      front: mediaPath.optional(),
      left: mediaPath.optional(),
      back: mediaPath.optional(),
      right: mediaPath.optional(),
    })
    .optional(),
  /** What texturing paints when it has no reference views. */
  prompt: z.string().trim().min(1).max(2000).optional(),
  textureQuality: z.enum(["standard", "detailed", "extreme"]).optional(),
  rigType: z.enum(rigTypes).optional(),
  /** A retarget preset such as `preset:idle` or `preset:aquatic:march`. */
  animation: z
    .string()
    .regex(/^preset:[a-z0-9_]+(:[a-z0-9_]+)?$/, "Use a Tripo preset such as preset:idle.")
    .optional(),
  outputCount: z.literal(1).default(1),
});
export const mediaRequest = z.discriminatedUnion("kind", [
  imageRequest,
  textRequest,
  videoRequest,
  modelRequest,
  agentRequest,
  modelEditRequest,
]);
export type MediaRequest = z.output<typeof mediaRequest>;
/** Runs BB executes as threads, rather than the host's media providers. */
export function runsOnBb<T extends { kind: MediaRequest["kind"] }>(
  request: T,
): request is Extract<T, { kind: "text" | "agent" }> {
  return request.kind === "text" || request.kind === "agent";
}
/** A texturing run's reference views, in Tripo's front, left, back, right order. */
export function editViewPaths(request: z.output<typeof modelEditRequest>) {
  return modelViews.flatMap((view) =>
    request.views?.[view] ? [[view, request.views[view]] as const] : [],
  );
}
/** A 3D request's images by view, front first. */
export function modelViewPaths(request: z.output<typeof modelRequest>) {
  const views = { ...request.views, front: request.approvedImagePath };
  return modelViews.flatMap((view) => (views[view] ? [[view, views[view]] as const] : []));
}
/** Every image a request reads, in the order providers receive them. */
export function generationImagePaths(request: MediaRequest): string[] {
  if (request.kind === "image" || request.kind === "text" || request.kind === "agent")
    return request.images;
  if (request.kind === "model-edit") return editViewPaths(request).map(([, path]) => path);
  if (request.kind === "video")
    return [request.imagePath, request.endImagePath].filter(
      (path): path is string => path !== undefined,
    );
  return modelViewPaths(request).map(([, path]) => path);
}
export const generationTarget = z.strictObject({
  boardId: generationId,
  nodeId: generationId,
  fingerprint: z.string(),
  imageRevisions: z
    .array(z.strictObject({ path: mediaPath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .min(1)
    .max(14)
    .optional(),
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
  reasoningLevel: reasoningLevel.optional(),
  serviceTier: serviceTier.optional(),
  /** Write an image or video node's prompt with a BB model instead of generating media. */
  brief: z.literal(true).optional(),
  /** Review this output of an image or 3D node instead of generating. */
  reviewAssetId: z.string().min(1).max(100).optional(),
  /** Have an image node's judge choose between its shortlist, or its takes, instead. */
  judge: z.literal(true).optional(),
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
    models: ["gemini-nano-banana-2.1", "gemini-omni-1.1-flash-preview"],
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
    kinds: ["model-3d", "model-edit"],
    imageOutputs: [],
    videoOutputs: [],
    transparency: false,
  },
] as const;

/** Provider policy belongs here, not in agent-authored CLI flags. */
export function normalizeMediaRequest(request: MediaRequest): MediaRequest {
  if (runsOnBb(request)) {
    if (request.model.provider !== "bb")
      throw new Error("Text and agent runs use the selected BB provider.");
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
  tripo: normalizeTripo,
};
function normalizeTripo(request: MediaRequest): MediaRequest {
  if (request.kind !== "model-edit") return request;
  const { operation } = request;
  if (operation === "texture" && !request.prompt && !editViewPaths(request).length)
    throw new Error("Texturing needs a texture prompt or at least one reference view.");
  if (operation === "rig" && !request.rigType)
    throw new Error("Choose the rig type, such as aquatic for a fish or shark.");
  if (operation === "animate" && !request.animation)
    throw new Error("Choose an animation preset, such as preset:idle.");
  if (operation === "animate" && !request.sourceTaskId)
    throw new Error("Animate a model rigged by a Tripo Rig node on this machine.");
  return request;
}
function normalizeMidjourney(request: MediaRequest): MediaRequest {
  if (request.kind === "model-3d" || request.kind === "model-edit" || runsOnBb(request))
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
  if (request.kind !== "video") throw new Error("Google supports only images and video.");
  if (
    (request.model.id && request.model.id !== "gemini-omni-1.1-flash-preview") ||
    request.duration > 10
  )
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
