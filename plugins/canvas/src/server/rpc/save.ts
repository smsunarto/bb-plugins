import { defineMutation } from "@bb-kit/core/rpc";
import { saveInputSchema, saveOutputSchema, type SaveOutput } from "../../shared/file.ts";
import { locateSource } from "../locate.ts";

export const save = defineMutation({
  input: saveInputSchema,
  output: saveOutputSchema,
  async execute(ctx, { source, content, expectedSha256 }): Promise<SaveOutput> {
    const located = await locateSource(ctx.bb, source);
    if (!located.ok) throw new Error(located.detail);
    const written = await ctx.bb.sdk.files.write({
      ...located.location,
      content,
      contentEncoding: "utf8",
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    });
    return written.outcome === "written"
      ? { outcome: "written", sha256: written.sha256 }
      : { outcome: "conflict" };
  },
});
