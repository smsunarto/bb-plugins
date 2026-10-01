import type { Context } from "@bb-kit/core/plugin";
import { defineQuery } from "@bb-kit/core/rpc";
import { liveFileInput, liveFileOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardServices } from "../../shared/contracts/engine.ts";
import { createHostResolver } from "../lib/host-resolver.ts";

/** Reuse the source route's containment and current-bytes checks before opening bb's editor. */
export const liveFile = defineQuery({
  input: liveFileInput,
  output: liveFileOutput,
  async execute(ctx: Context<Pick<WhiteboardServices, "engine">>, input) {
    // Explicit pins name historical source, even if that revision happens to equal HEAD.
    if (input.head || input.base) return { target: null };
    if (input.version !== undefined && !input.generation) return { target: null };
    const query = new URLSearchParams({ file: input.path, side: "head" });
    if (input.version !== undefined) query.set("version", String(input.version));
    if (input.generation) query.set("generation", input.generation);
    const response = await ctx.engine.request({
      method: "GET",
      path: `/${encodeURIComponent(input.sessionId)}/file?${query}`,
    });
    if (response.status !== 200) return { target: null };
    const file = JSON.parse(response.body) as { localPath?: string };
    if (!file.localPath) return { target: null };
    const hostId = await createHostResolver(ctx.bb).hostFor({ rootPath: file.localPath });
    return { target: { kind: "host" as const, hostId, path: file.localPath } };
  },
});
