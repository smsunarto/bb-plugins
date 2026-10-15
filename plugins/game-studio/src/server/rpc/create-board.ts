import { defineMutation } from "@bb-kit/core/rpc";
import { createBoardInput, workspaceSchema } from "../../shared/schema.ts";
import { createBoard as runCreateBoard } from "../lib/studio.ts";

export const createBoard = defineMutation({
  input: createBoardInput,
  output: workspaceSchema,
  execute(ctx, input) {
    return runCreateBoard(ctx.bb, input);
  },
});
