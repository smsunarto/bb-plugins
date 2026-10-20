import { z } from "zod";

/** Review modes in sidebar order, grouped by what they inspect. */
export const reviewModes = [
  { id: "shaded", label: "Shaded", key: "1", group: "surface", kind: "shaded", needs: null },
  {
    id: "base-color",
    label: "Base color",
    key: "2",
    group: "surface",
    kind: "color",
    map: "map",
    factor: "color",
    needs: null,
  },
  {
    id: "normal-map",
    label: "Normal map",
    key: "3",
    group: "surface",
    kind: "color",
    map: "normalMap",
    needs: "normalMap",
  },
  {
    id: "metallic",
    label: "Metallic",
    group: "surface",
    kind: "scalar",
    map: "metalnessMap",
    factor: "metalness",
    channel: 2,
    needs: null,
  },
  {
    id: "roughness",
    label: "Roughness",
    group: "surface",
    kind: "scalar",
    map: "roughnessMap",
    factor: "roughness",
    channel: 1,
    needs: null,
  },
  {
    id: "occlusion",
    label: "Occlusion",
    group: "surface",
    kind: "scalar",
    map: "aoMap",
    channel: 0,
    needs: "aoMap",
  },
  {
    id: "emissive",
    label: "Emissive",
    group: "surface",
    kind: "color",
    map: "emissiveMap",
    factor: "emissive",
    needs: null,
  },
  {
    id: "wireframe",
    label: "Wireframe",
    key: "4",
    group: "geometry",
    kind: "wireframe",
    overlay: false,
    needs: null,
  },
  {
    id: "topology",
    label: "Topology overlay",
    group: "geometry",
    kind: "wireframe",
    overlay: true,
    needs: null,
  },
  {
    id: "normals",
    label: "Vertex normals",
    group: "geometry",
    kind: "normals",
    flat: false,
    needs: "normals",
  },
  {
    id: "geometric-normals",
    label: "Face normals",
    group: "geometry",
    kind: "normals",
    flat: true,
    needs: null,
  },
  {
    id: "bounds",
    label: "Bounds and scale",
    key: "8",
    group: "geometry",
    kind: "bounds",
    needs: null,
  },
  { id: "uv", label: "UV checker", key: "5", group: "uv", kind: "uv", layout: false, needs: "uv" },
  { id: "uv-layout", label: "UV layout", group: "uv", kind: "uv", layout: true, needs: "uv" },
  { id: "skeleton", label: "Skeleton", key: "6", group: "rig", kind: "skeleton", needs: "skin" },
  { id: "weights", label: "Skin weights", key: "7", group: "rig", kind: "weights", needs: "skin" },
] as const;
export const modeGroups = [
  { id: "surface", label: "Surface" },
  { id: "geometry", label: "Geometry" },
  { id: "uv", label: "UVs" },
  { id: "rig", label: "Rig" },
] as const;
export type ReviewMode = (typeof reviewModes)[number]["id"];
export type ModelFacts = {
  uv: boolean;
  normals: boolean;
  skin: boolean;
  normalMap: boolean;
  aoMap: boolean;
};
const reasons: Record<keyof ModelFacts, string> = {
  uv: "No UV0",
  normals: "No vertex normals",
  skin: "No skin",
  normalMap: "No normal map",
  aoMap: "No occlusion map",
};
export function modeAvailability(facts: ModelFacts) {
  return reviewModes.map((mode) => ({
    ...mode,
    reason: mode.needs && !facts[mode.needs] ? reasons[mode.needs] : null,
  }));
}
/** Labelled ruler times for a clip: fewer than seven, on a round step. */
export function rulerTicks(duration: number) {
  const step =
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find((value) => duration / value < 6) ??
    Math.ceil(duration / 5);
  return Array.from({ length: Math.floor(duration / step + 1e-6) + 1 }, (_, index) =>
    Number((index * step).toFixed(2)),
  );
}
export const cameras = ["front", "back", "left", "right", "top", "three-quarter"] as const;
export type CameraPreset = (typeof cameras)[number];
export const shotSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  mode: z.enum(reviewModes.map((mode) => mode.id)).default("shaded"),
  camera: z.enum(cameras).default("three-quarter"),
  joint: z.number().int().min(0).default(0),
  orbit: z
    .strictObject({
      position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
      target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    })
    .refine(
      (pose) => pose.position.some((value, index) => value !== pose.target[index]),
      "Camera position must differ from target",
    )
    .optional(),
  animation: z
    .strictObject({
      clip: z.string().min(1),
      time: z.number().finite().min(0).default(0),
      speed: z.number().finite().min(0).max(4).default(1),
      loop: z.boolean().default(true),
    })
    .optional(),
  video: z
    .strictObject({
      duration: z.number().finite().min(0.1).max(30),
      fps: z.number().int().min(1).max(60).default(24),
      turntable: z.boolean().default(false),
    })
    .optional(),
});
export const shotScriptSchema = z
  .strictObject({
    width: z.number().int().min(64).max(2048).default(1280),
    height: z.number().int().min(64).max(2048).default(720),
    shots: z.array(shotSchema).min(1).max(20),
  })
  .superRefine((script, ctx) => {
    if (new Set(script.shots.map((shot) => shot.name)).size !== script.shots.length)
      ctx.addIssue({ code: "custom", message: "Shot names must be unique" });
    const frames = script.shots.reduce((sum, shot) => sum + frameCount(shot.video), 0);
    if (frames > 1800 || frames * script.width * script.height > 2_000_000_000)
      ctx.addIssue({
        code: "custom",
        message: "Capture exceeds frame/pixel budget. Split it into separate runs.",
      });
    if (script.shots.some((shot) => shot.video) && (script.width % 2 || script.height % 2))
      ctx.addIssue({ code: "custom", message: "Video dimensions must be even" });
  });
export type ShotScript = z.infer<typeof shotScriptSchema>;
export function parseShotScript(value: unknown): ShotScript {
  return shotScriptSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
}
export function frameCount(video?: { duration: number; fps: number }) {
  return video ? Math.max(1, Math.ceil(video.duration * video.fps)) : 1;
}
export function frameTime(index: number, fps: number) {
  return index / fps;
}
export function animationTime(time: number, duration: number, loop: boolean) {
  return duration > 0 ? (loop ? time % duration : Math.min(time, duration)) : 0;
}
export const modelEvidenceInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("file"),
    gameId: z.string(),
    runId: z.uuid(),
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}\.(png|mp4)$/),
    content: z.string().max(34_952_536),
  }),
  z.strictObject({
    action: z.literal("finish"),
    gameId: z.string(),
    runId: z.uuid(),
    model: z.string().min(1).max(1000),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    script: shotScriptSchema,
  }),
]);
export type ModelEvidenceInput = z.infer<typeof modelEvidenceInput>;
