import { defineMutation } from "@bb-kit/core/rpc";
import { quickCreateSchema, quickResultSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const quickCreate = defineMutation({
  input: quickCreateSchema,
  output: quickResultSchema,
  execute: (ctx: CloudflareContext, input) => ctx.quickShares.create(input),
});
