import { defineQuery } from "@bb-kit/core/rpc";
import { gameInput, previewSchema } from "../../shared/schema.ts";
import { createPreview } from "../lib/studio.ts";

export const preview = defineQuery({
  input: gameInput,
  output: previewSchema,
  execute(ctx, input) {
    return createPreview(ctx.bb, input.gameId);
  },
});
