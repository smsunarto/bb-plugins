import { defineQuery } from "@bb-kit/core/rpc";
import { gameInput, workspaceSchema } from "../../shared/schema.ts";
import { readWorkspace, type WorkspaceContext } from "../lib/workspace-read.ts";

export const get = defineQuery({
  input: gameInput,
  output: workspaceSchema,
  execute(ctx: WorkspaceContext, input) {
    return readWorkspace(ctx, input.gameId);
  },
});
