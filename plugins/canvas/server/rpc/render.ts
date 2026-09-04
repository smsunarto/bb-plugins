import { defineQuery } from "@bb-kit/core/rpc";
import { renderInputSchema, renderOutputSchema, type RenderOutput } from "../../shared/document.ts";
import { parseCanvas } from "../parse.ts";
import { readCanvasFile } from "../read.ts";

export const render = defineQuery({
  input: renderInputSchema,
  output: renderOutputSchema,
  async execute(ctx, { source, knownSha256 }): Promise<RenderOutput> {
    const read = await readCanvasFile(ctx.bb, source);
    if (!read.ok) return { status: "unreadable", reason: read.reason, detail: read.detail };
    const { file } = read;
    if (knownSha256 !== null && knownSha256 === file.sha256) {
      return { status: "unchanged", sha256: file.sha256 };
    }
    const parsed = parseCanvas(file.content);
    if (!parsed.ok) {
      return { status: "unparseable", sha256: file.sha256, diagnostic: parsed.diagnostic };
    }
    return {
      status: "rendered",
      sha256: file.sha256,
      modifiedAtMs: file.modifiedAtMs,
      document: parsed.document,
    };
  },
});
