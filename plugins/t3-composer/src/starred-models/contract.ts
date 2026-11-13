import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Starred models are one list per BB server, so every device shows the same stars. This module
// is shared by the server entry and the app bundle; keep it free of server-only imports.

const starredModelSchema = z
  .object({ providerId: z.string().min(1).max(200), model: z.string().min(1).max(200) })
  .strict();
export type StarredModel = z.infer<typeof starredModelSchema>;

/** More than any picker shows; keeps the stored list far below the key-value size limit. */
export const MAX_STARRED_MODELS = 200;
export const STARRED_MODELS_TAG = "starred-models";

const starredModelsSchema = z.object({ models: z.array(starredModelSchema) });

export const t3ComposerContract = defineRpcContract({
  starredModels: {
    input: z.null(),
    output: starredModelsSchema,
    tags: () => [STARRED_MODELS_TAG],
  },
  /** Adds and removes by value, so repeating a call or racing another device changes nothing more. */
  changeStarredModels: {
    input: z
      .object({
        add: z.array(starredModelSchema).max(MAX_STARRED_MODELS),
        remove: z.array(starredModelSchema).max(MAX_STARRED_MODELS),
      })
      .strict(),
    output: starredModelsSchema,
  },
});

export interface StarredModelsChange {
  add: readonly StarredModel[];
  remove: readonly StarredModel[];
}

export function starKey(providerId: string, model: string) {
  return `${providerId}\u0000${model}`;
}

/**
 * The list after a change, in star order with new stars last. Returns `current` itself when
 * nothing changes, so callers can skip the write.
 */
export function changeStarredModels(
  current: readonly StarredModel[],
  change: StarredModelsChange,
): readonly StarredModel[] {
  const removed = new Set(change.remove.map((entry) => starKey(entry.providerId, entry.model)));
  const kept = current.filter((entry) => !removed.has(starKey(entry.providerId, entry.model)));
  const present = new Set(kept.map((entry) => starKey(entry.providerId, entry.model)));
  const added: StarredModel[] = [];
  for (const entry of change.add) {
    const key = starKey(entry.providerId, entry.model);
    if (present.has(key) || removed.has(key)) continue;
    present.add(key);
    added.push({ providerId: entry.providerId, model: entry.model });
  }
  if (added.length === 0 && kept.length === current.length) return current;
  return [...kept, ...added];
}
