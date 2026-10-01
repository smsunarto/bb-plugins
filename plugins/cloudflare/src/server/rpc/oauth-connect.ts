import { defineMutation } from "@bb-kit/core/rpc";
import { oauthConnectSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const oauthConnect = defineMutation({
  output: oauthConnectSchema,
  execute: (ctx: CloudflareContext) => ctx.oauth.connect(),
});
