import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import {
  editorAction,
  editorActionSchema,
  type EditorsContext,
} from "../lib/unity-editor-action.ts";

export const manage = defineTool({
  parameters: editorActionSchema,
  async execute(ctx: ToolContext<EditorsContext>, input) {
    return JSON.stringify(
      await editorAction(ctx, input, ctx.tool.threadId ?? undefined, ctx.tool.signal),
    );
  },
});
