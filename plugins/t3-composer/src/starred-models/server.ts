import {
  experimental_PluginRpcRefusal as PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import {
  changeStarredModels,
  MAX_STARRED_MODELS,
  STARRED_MODELS_TAG,
  t3ComposerContract,
  type StarredModel,
} from "./contract";

const STORAGE_KEY = "starred-models";

function isStarredModel(value: unknown): value is StarredModel {
  if (typeof value !== "object" || value === null) return false;
  const { providerId, model } = value as Record<string, unknown>;
  return typeof providerId === "string" && typeof model === "string";
}

/** Serves the starred models from the plugin's key-value storage and applies changes to them. */
export function registerStarredModels(bb: BbPluginApi) {
  // Changes run one at a time, so two devices starring at once both keep their star.
  let writes: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<readonly StarredModel[]> => {
    const stored = await bb.storage.kv.get<unknown>(STORAGE_KEY);
    return Array.isArray(stored) ? stored.filter(isStarredModel) : [];
  };

  bb.rpc.register(t3ComposerContract, {
    async starredModels() {
      return { models: [...(await read())] };
    },
    changeStarredModels(change) {
      const run = writes.then(async () => {
        const current = await read();
        const next = changeStarredModels(current, change);
        if (next === current) return { models: [...current] };
        if (next.length > MAX_STARRED_MODELS) {
          throw new PluginRpcRefusal({
            code: "invalid",
            message: `You can star up to ${MAX_STARRED_MODELS} models.`,
          });
        }
        await bb.storage.kv.set(STORAGE_KEY, next);
        bb.rpc.experimental_invalidate([STARRED_MODELS_TAG]);
        return { models: [...next] };
      });
      writes = run.catch(() => undefined);
      return run;
    },
  });
}
