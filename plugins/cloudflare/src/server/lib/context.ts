import type { Context } from "@bb-kit/core/plugin";
import type { CloudflareOAuth } from "./oauth.ts";
import type { QuickShareService } from "./quick-shares.ts";
import type { CloudflareService } from "./service.ts";

/** What `services` adds to every handler's ctx. */
export type CloudflareContext = Context<{
  cloudflare: CloudflareService;
  oauth: CloudflareOAuth;
  quickShares: QuickShareService;
}>;
