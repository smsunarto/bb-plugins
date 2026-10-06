import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { repositoryKeySchema } from "../../shared/schema.ts";
import { claimConflictResolution } from "../lib/conflict-resolution.ts";
import { conflictPrompt } from "../lib/prompts.ts";
import { locateRepository, spawnSubthread } from "../lib/subthreads.ts";

/**
 * Resolve conflicts hands every conflict in the repository, conflicted
 * commits and files with conflict markers alike, to one subthread of the
 * reader's thread, on the same workspace. The repository keeps that one
 * subthread until it is archived: asking while it works returns it, from this
 * thread or another on the same workspace, and asking once it stopped sends
 * it the job again. It may have stopped to ask the user something, and a
 * second resolver would rewrite the same commits.
 */
export const resolveConflicts = defineMutation({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: z.object({ threadId: z.string() }).strict(),
  async execute(ctx, { threadId, repositoryKey }) {
    const repository = await locateRepository(ctx.bb, threadId, repositoryKey);
    const prompt = conflictPrompt(repository.path);
    const childId = await claimConflictResolution(ctx.bb, repository, async (current) => {
      if (current?.running) return current.threadId;
      if (current) {
        await ctx.bb.sdk.threads.send({
          threadId: current.threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: prompt, mentions: [] }],
        });
        return current.threadId;
      }
      // The folder name, on either kind of host path.
      const name = repository.path.split(/[\\/]/).findLast(Boolean) ?? repository.key;
      return spawnSubthread(ctx.bb, threadId, { title: `Resolve conflicts in ${name}`, prompt });
    });
    return { threadId: childId };
  },
});
