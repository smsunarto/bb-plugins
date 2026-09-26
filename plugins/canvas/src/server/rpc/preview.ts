import { posix, win32 } from "node:path";
import { defineQuery } from "@bb-kit/core/rpc";
import { previewInputSchema, previewOutputSchema } from "../../shared/file.ts";
import { locateSource } from "../locate.ts";

export const preview = defineQuery({
  input: previewInputSchema,
  output: previewOutputSchema,
  async execute(ctx, { source }) {
    const located = await locateSource(ctx.bb, source);
    if (!located.ok) throw new Error(located.detail);
    const { hostId, path } = located.location;
    // A host file has no enclosing worktree, so its own directory is the root.
    const paths = win32.isAbsolute(path) && !posix.isAbsolute(path) ? win32 : posix;
    const rootPath = located.location.rootPath ?? paths.dirname(path);
    const lease = await ctx.bb.sdk.files.createPreview({
      ...(hostId === undefined ? {} : { hostId }),
      rootPath,
    });
    return {
      baseUrl: lease.baseUrl,
      expiresAtMs: lease.expiresAtMs,
      path: paths.relative(rootPath, path).replaceAll("\\", "/"),
    };
  },
});
