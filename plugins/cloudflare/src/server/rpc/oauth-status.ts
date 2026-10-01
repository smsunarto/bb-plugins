import { defineQuery } from "@bb-kit/core/rpc";
import { oauthStatusSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const oauthStatus = defineQuery({
  output: oauthStatusSchema,
  execute: (ctx: CloudflareContext) => ctx.oauth.status(),
});
