import type { Context } from "@bb-kit/core/plugin";
import { defineQuery } from "@bb-kit/core/rpc";
import { infoInput, infoOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardServices } from "../../shared/contracts/engine.ts";

/** App version and feature flags for a panel (design §3.2). Owned by WP8. */
export const info = defineQuery({
  input: infoInput,
  output: infoOutput,
  async execute(ctx: Context<Pick<WhiteboardServices, "engine">>, input) {
    return ctx.engine.info(input);
  },
});
