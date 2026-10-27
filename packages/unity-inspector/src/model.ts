import { z } from "zod";

export const unityDiffSchema = z.strictObject({
  groups: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      hierarchy: z.string(),
      status: z.enum(["added", "removed", "modified"]),
      components: z.array(
        z.strictObject({
          id: z.string(),
          type: z.string(),
          status: z.enum(["added", "removed", "modified"]),
          properties: z.array(
            z.strictObject({
              path: z.string(),
              label: z.string().optional(),
              target: z.string().optional(),
              before: z.string().nullable(),
              after: z.string().nullable(),
            }),
          ),
        }),
      ),
    }),
  ),
  propertyCount: z.number().int().nonnegative(),
});

export type UnityDiff = z.output<typeof unityDiffSchema>;
export const isUnityAsset = (path: string) => /\.(prefab|unity)$/i.test(path);

/**
 * Unity's YAML-serialized asset types, by extension, named the way the Editor
 * names them. Any of them may be saved in binary instead; parsing tells.
 */
const UNITY_YAML_KINDS: Readonly<Record<string, string>> = {
  unity: "Scene",
  prefab: "Prefab",
  asset: "Asset",
  mat: "Material",
  anim: "Animation clip",
  controller: "Animator controller",
  overridecontroller: "Animator override controller",
  mask: "Avatar mask",
  physicmaterial: "Physics material",
  physicsmaterial: "Physics material",
  physicsmaterial2d: "Physics material 2D",
  mixer: "Audio mixer",
  lighting: "Lighting settings",
  rendertexture: "Render texture",
  cubemap: "Cubemap",
  flare: "Lens flare",
  guiskin: "GUI skin",
  fontsettings: "Font settings",
  spriteatlas: "Sprite atlas",
  spriteatlasv2: "Sprite atlas",
  terrainlayer: "Terrain layer",
  brush: "Brush",
  playable: "Timeline",
  signal: "Signal",
  preset: "Preset",
  shadervariants: "Shader variant collection",
  giparams: "Lightmap parameters",
};

/** The Unity asset type a path's extension names, or null for any other file. */
export function unityYamlKind(path: string): string | null {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return (extension && UNITY_YAML_KINDS[extension]) || null;
}
export const isUnityMeta = (path: string) => /\.meta$/i.test(path);

export const unityMetaDiffSchema = z.strictObject({
  guid: z.strictObject({ before: z.string().nullable(), after: z.string().nullable() }),
  importer: z.strictObject({ before: z.string().nullable(), after: z.string().nullable() }),
  properties: z.array(
    z.strictObject({
      path: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
  propertyCount: z.number().int().nonnegative(),
});
export type UnityMetaDiff = z.output<typeof unityMetaDiffSchema>;

const citationPropertySchema = z.strictObject({
  path: z.string(),
  label: z.string().optional(),
  target: z.string().optional(),
  value: z.string(),
});
export const unityCitationSchema = z.strictObject({
  groups: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      hierarchy: z.string(),
      components: z.array(
        z.strictObject({
          id: z.string(),
          type: z.string(),
          properties: z.array(citationPropertySchema),
        }),
      ),
    }),
  ),
  propertyCount: z.number().int().nonnegative(),
});
export type UnityCitation = z.output<typeof unityCitationSchema>;
