import { defineMutation } from "@bb-kit/core/rpc";
import { recordRequestInput, unityRequestSchema } from "../../shared/schema.ts";
import { recordRequest as runRecordRequest } from "../lib/studio.ts";

export const recordRequest = defineMutation({
  input: recordRequestInput,
  output: unityRequestSchema,
  execute(ctx, input) {
    return runRecordRequest(ctx.bb, input);
  },
});
