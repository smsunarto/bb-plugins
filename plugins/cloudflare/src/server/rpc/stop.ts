import { defineMutation } from "@bb-kit/core/rpc";
import { shareInputSchema, resultSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const stop = defineMutation({
  input: shareInputSchema,
  output: resultSchema,
  execute: (ctx: CloudflareContext, input) => ctx.cloudflare.stop(input.id, input.expectedRevision),
});
