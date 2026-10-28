import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  blobDescriptorSchema,
  blobPathSchema,
  commitIdSchema,
  environmentPathSchema,
} from "../../shared/schema.ts";
import { recentCheckoutPaths } from "../lib/checkout-paths.ts";
import { hostClient } from "../lib/target.ts";

export const branchBlobsContract = {
  input: z
    .object({
      hostId: z.string().min(1),
      path: environmentPathSchema,
      items: z
        .array(z.object({ rev: commitIdSchema, path: blobPathSchema }).strict())
        .min(1)
        .max(8),
    })
    .strict(),
  output: z.object({ items: z.array(blobDescriptorSchema) }).strict(),
};

/**
 * What each path holds at its commit in the repository at `path` on
 * `hostId`, read without its content: another plugin's preview of a branch's
 * images, models, and assets decides from this how to read them. Only a
 * GitButler workspace among the checkouts bb knows there is read.
 */
export async function branchBlobs(
  ctx: GitButlerContext,
  { hostId, path, items }: z.output<typeof branchBlobsContract.input>,
): Promise<z.input<typeof branchBlobsContract.output>> {
  const machine = (await recentCheckoutPaths(ctx.bb)).find(({ host }) => host.id === hostId);
  if (!machine) throw new Error("bb knows no checkout on that machine, or it is offline.");
  return hostClient(ctx.bb).call(
    "blobs",
    { environmentPath: path, within: machine.paths, items },
    { hostId },
  );
}
