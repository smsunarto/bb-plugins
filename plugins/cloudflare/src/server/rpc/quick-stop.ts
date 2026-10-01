import { defineMutation } from "@bb-kit/core/rpc";
import { quickIdSchema, quickResultSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const quickStop = defineMutation({
  input: quickIdSchema,
  output: quickResultSchema,
  execute: (ctx: CloudflareContext, input) => ctx.quickShares.stop(input.id),
});
