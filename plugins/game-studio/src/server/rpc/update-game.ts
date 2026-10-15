import { defineMutation } from "@bb-kit/core/rpc";
import { gameSchema, updateGameInput } from "../../shared/schema.ts";
import { updateGame as runUpdateGame } from "../lib/studio.ts";

export const updateGame = defineMutation({
  input: updateGameInput,
  output: gameSchema,
  execute(ctx, input) {
    return runUpdateGame(ctx.bb, input);
  },
});
