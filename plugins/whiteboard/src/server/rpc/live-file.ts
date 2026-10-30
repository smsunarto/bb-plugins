import type { z } from "zod";
import { liveFileInput, liveFileOutput } from "../../shared/contracts/rpc.ts";
import type { WhiteboardContext } from "../lib/context.ts";
import { createHostResolver } from "../lib/host-resolver.ts";

/** Reuse the file read's containment and current-bytes checks before opening bb's editor. */
export const liveFileContract = { input: liveFileInput, output: liveFileOutput };

export async function liveFile(
  ctx: WhiteboardContext<"engine">,
  input: z.output<typeof liveFileContract.input>,
): Promise<z.input<typeof liveFileContract.output>> {
  // Explicit pins name historical source, even if that revision happens to equal HEAD.
  if (input.head || input.base) return { target: null };
  if (input.version !== undefined && !input.generation) return { target: null };
  let file;
  try {
    file = await ctx.engine.run({ threadId: input.threadId }, () =>
      ctx.engine.api.file({
        reviewId: input.sessionId,
        file: input.path,
        side: "head",
        version: input.version,
        generation: input.generation,
      }),
    );
  } catch {
    // A file the panel cannot read live stays in the panel.
    return { target: null };
  }
  if (!file.localPath) return { target: null };
  const hostId = await createHostResolver(ctx.bb).hostFor({ rootPath: file.localPath });
  return { target: { kind: "host" as const, hostId, path: file.localPath } };
}
