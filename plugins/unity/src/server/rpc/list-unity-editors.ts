import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { editorInventorySchema } from "../../shared/unity-editor-contract.ts";
import type { EditorsContext } from "../lib/unity-editor-action.ts";
import { editorHost } from "../lib/unity-editors.ts";

export const listUnityEditors = defineQuery({
  input: z.object({ hostId: z.string().optional(), threadId: z.string().optional() }).strict(),
  output: editorInventorySchema,
  description: "Discover Unity Editors and checkout slots with public ownership information.",
  async execute(ctx: EditorsContext, { hostId, threadId }) {
    await ctx.ensureLegacyClaims();
    const host = await editorHost(ctx.bb, threadId, hostId);
    // RPC threadId selects a host; only the managed tool/CLI may expose an owner's claim token.
    return ctx.unityEditors.list(host);
  },
});
