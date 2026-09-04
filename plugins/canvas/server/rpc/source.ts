import { defineQuery } from "@bb-kit/core/rpc";
import { sourceOutputSchema, stateInputSchema, type SourceOutput } from "../../shared/document.ts";
import { readCanvasFile } from "../read.ts";

// Raw text for the page's source view. The file opener delegates that view to
// BB's own preview, but a nav panel has no preview to delegate to.
export const source = defineQuery({
  input: stateInputSchema,
  output: sourceOutputSchema,
  async execute(ctx, { source }): Promise<SourceOutput> {
    const read = await readCanvasFile(ctx.bb, source);
    if (!read.ok) return { status: "unreadable", reason: read.reason, detail: read.detail };
    return { status: "ok", sha256: read.file.sha256, content: read.file.content };
  },
});
