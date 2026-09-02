import { defineQuery } from "@bb-kit/core/rpc";
import { renderInputSchema, renderOutputSchema, type RenderOutput } from "../../shared/document.ts";
import { locateSource } from "../locate.ts";
import { maxCanvasBytes, parseCanvas } from "../parse.ts";

function classifyReadError(error: unknown): RenderOutput {
  const detail = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|not found|does not exist|ENOTDIR/i.test(detail)) {
    return { status: "unreadable", reason: "missing", detail };
  }
  if (/too large|exceeds|size limit/i.test(detail)) {
    return { status: "unreadable", reason: "too-large", detail };
  }
  return { status: "unreadable", reason: "host-offline", detail };
}

export const render = defineQuery({
  input: renderInputSchema,
  output: renderOutputSchema,
  async execute(ctx, { source, knownSha256 }): Promise<RenderOutput> {
    const located = await locateSource(ctx.bb, source);
    if (!located.ok) {
      return { status: "unreadable", reason: located.reason, detail: located.detail };
    }
    let file: Awaited<ReturnType<typeof ctx.bb.sdk.files.read>>;
    try {
      file = await ctx.bb.sdk.files.read(located.location);
    } catch (error) {
      return classifyReadError(error);
    }
    if (file.contentEncoding !== "utf8") {
      return { status: "unreadable", reason: "binary", detail: "the file is not UTF-8 text" };
    }
    if (file.content.length > maxCanvasBytes) {
      return {
        status: "unreadable",
        reason: "too-large",
        detail: `the file is ${file.content.length} bytes; the limit is ${maxCanvasBytes}`,
      };
    }
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
      modifiedAtMs: file.modifiedAtMs ?? null,
      document: parsed.document,
    };
  },
});
