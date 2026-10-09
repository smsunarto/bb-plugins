import { defineQuery } from "@bb-kit/core/rpc";
import { renderInputSchema, renderOutputSchema, type RenderOutput } from "../../shared/document.ts";
import { parseCanvas } from "../../shared/parse.ts";
import { readCanvasFile } from "../read.ts";

export const render = defineQuery({
  input: renderInputSchema,
  output: renderOutputSchema,
  async execute(ctx, { source, knownSha256 }): Promise<RenderOutput> {
    const read = await readCanvasFile(ctx.bb, source, knownSha256);
    if (read.status !== "read") return read;
    const { file } = read;
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
