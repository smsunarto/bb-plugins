import type { Context } from "@bb-kit/core/plugin";
import { defineQuery } from "@bb-kit/core/rpc";
import { liveFileInput, liveFileOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardServices } from "../../shared/contracts/engine.ts";

/** The live host file behind a session path, for bb's file opener (design §0.1). Owned by WP7. */
export const liveFile = defineQuery({
  input: liveFileInput,
  output: liveFileOutput,
  async execute(_ctx: Context<Pick<WhiteboardServices, "engine">>, _input) {
    return { target: null };
  },
});
