import { defineMutation } from "@bb-kit/core/rpc";
import { oauthDisconnectSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const oauthDisconnect = defineMutation({
  output: oauthDisconnectSchema,
  execute: (ctx: CloudflareContext) => ctx.oauth.disconnect(),
});
