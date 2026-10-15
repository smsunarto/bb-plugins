import { defineQuery } from "@bb-kit/core/rpc";
import { gameInput, workspaceSchema } from "../../shared/schema.ts";
import { loadWorkspace } from "../lib/studio.ts";

export const get = defineQuery({
  input: gameInput,
  output: workspaceSchema,
  execute(ctx, input) {
    return loadWorkspace(ctx.bb, input.gameId);
  },
});
