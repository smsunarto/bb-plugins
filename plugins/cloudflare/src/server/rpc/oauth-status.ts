import { defineQuery } from "@bb-kit/core/rpc";
import { oauthStatusSchema } from "../../shared/schema.ts";
import { getOAuth } from "../lib/service.ts";
export const oauthStatus = defineQuery({
  output: oauthStatusSchema,
  execute: (ctx) => getOAuth(ctx.bb).status(),
});
