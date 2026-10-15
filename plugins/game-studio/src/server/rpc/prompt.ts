import { defineQuery } from "@bb-kit/core/rpc";
import { promptInput, promptSchema } from "../../shared/schema.ts";
import { prompt as buildPrompt } from "../lib/studio.ts";

export const prompt = defineQuery({
  input: promptInput,
  output: promptSchema,
  execute(ctx, input) {
    return buildPrompt(ctx.bb, input);
  },
});
