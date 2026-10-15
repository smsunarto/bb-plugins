import { defineMutation } from "@bb-kit/core/rpc";
import { createGameInput, gameSchema } from "../../shared/schema.ts";
import { createGame } from "../lib/studio.ts";

export const create = defineMutation({
  input: createGameInput,
  output: gameSchema,
  execute(ctx, input) {
    return createGame(ctx.bb, input);
  },
});
