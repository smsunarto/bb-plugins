import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import { BLOB_CHUNK_TIMEOUT_MS } from "../../shared/host-contract.ts";
import { blobObjectSchema, environmentPathSchema } from "../../shared/schema.ts";
import { recentCheckoutPaths } from "../lib/checkout-paths.ts";
import { hostClient } from "../lib/target.ts";

export const branchBlobChunkContract = {
  input: z
    .object({
      hostId: z.string().min(1),
      path: environmentPathSchema,
      object: blobObjectSchema,
      offset: z.number().int().nonnegative(),
      length: z
        .number()
        .int()
        .min(1)
        .max(4 * 1024 * 1024),
    })
    .strict(),
  output: z.object({ size: z.number().int().nonnegative(), content: z.string() }).strict(),
};

/**
 * One range of a file `branchBlobs` described, base64: a Git blob, or the
 * Git LFS object its pointer names, downloaded into the checkout's own store
 * first. A host call's result is capped, so a large file takes several.
 */
export async function branchBlobChunk(
  ctx: GitButlerContext,
  { hostId, path, object, offset, length }: z.output<typeof branchBlobChunkContract.input>,
): Promise<z.input<typeof branchBlobChunkContract.output>> {
  const machine = (await recentCheckoutPaths(ctx.bb)).find(({ host }) => host.id === hostId);
  if (!machine) throw new Error("bb knows no checkout on that machine, or it is offline.");
  return hostClient(ctx.bb).call(
    "blobChunk",
    { environmentPath: path, within: machine.paths, object, offset, length },
    // The first chunk of an LFS object may download it, which outlasts the default 30 seconds.
    { hostId, timeoutMs: BLOB_CHUNK_TIMEOUT_MS },
  );
}
