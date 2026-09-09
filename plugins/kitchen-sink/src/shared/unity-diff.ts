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
