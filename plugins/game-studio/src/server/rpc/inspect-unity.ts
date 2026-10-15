import { defineQuery } from "@bb-kit/core/rpc";
import { inspectUnityInput, inspectUnitySchema } from "../../shared/schema.ts";
import { inspectUnity as inspect } from "../lib/studio.ts";

export const inspectUnity = defineQuery({
  input: inspectUnityInput,
  output: inspectUnitySchema,
  execute(ctx, input) {
    return inspect(ctx.bb, input);
  },
});
