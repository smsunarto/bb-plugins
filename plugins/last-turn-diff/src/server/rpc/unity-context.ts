import { defineQuery } from "@bb-kit/core/rpc";
import { unityDiffSchema } from "@bb-plugins/unity-inspector/model";
import { z } from "zod";
import { latestTurnStore } from "../lib/latest-turn-store.ts";

export const unityContext = defineQuery({
  input: z.strictObject({
    threadId: z.string().min(1).max(200),
    revision: z.string().length(64),
    changeId: z.string().max(4096),
  }),
  output: z.object({ diff: unityDiffSchema.nullable() }),
  async execute({ bb }, { threadId, revision, changeId }) {
    return { diff: await latestTurnStore(bb).unity(threadId, revision, changeId) };
  },
});
