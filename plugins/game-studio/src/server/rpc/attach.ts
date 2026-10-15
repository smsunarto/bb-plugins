import { defineMutation } from "@bb-kit/core/rpc";
import { attachGameInput, gameSchema } from "../../shared/schema.ts";
import { attachGame } from "../lib/studio.ts";

export const attach = defineMutation({
  input: attachGameInput,
  output: gameSchema,
  execute(ctx, input) {
    return attachGame(ctx.bb, input);
  },
});
