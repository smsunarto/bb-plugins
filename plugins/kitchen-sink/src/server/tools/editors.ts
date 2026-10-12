import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import {
  editorAction,
  editorActionSchema,
  type EditorsContext,
} from "../lib/unity-editor-action.ts";

export const editors = defineTool({
  description:
    "Discover Unity Editors on the thread's enrolled host, declare which BB thread owns an exact instance, run guarded Pipeline commands, inspect job completion, and release. Runtime claims allow independent MPPM client inspection; authoring claims exclude other agents on the shared project and cannot be taken on clones. No automatic expiry or forced takeover of live Editors. Commands return tracked jobs: call status until claim.jobId is null before release. recover requires a dead Editor or a deleted/archived owner plus explicit completion evidence and native idle checks. Supply hostId only to select another enrolled host.",
  instructions:
    "For Unity work, discover and claim an Editor before controlling it. Use managed command/status/release for Pipeline operations. Do not bypass another thread's claim with direct unity CLI, UI, or agent-game calls. Shared Assets/Packages writes and scenario lifecycle require the main Editor's authoring claim. Claims guard participating tools; physical UI and direct CLI cannot be intercepted. Preserve dirty scenes and coordinate shared host focus.",
  parameters: editorActionSchema,
  async execute(ctx: ToolContext<EditorsContext>, input) {
    return JSON.stringify(
      await editorAction(ctx, input, ctx.tool.threadId ?? undefined, ctx.tool.signal),
    );
  },
});
