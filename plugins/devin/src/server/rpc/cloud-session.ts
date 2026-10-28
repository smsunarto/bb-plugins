import { z } from "zod";
import { cloudSessionView, DEVIN_PROVIDER_ID } from "../../shared/devin.ts";
import type { TargetsContext } from "../lib/targets.ts";

const cloudSessionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("hidden") }).strict(),
  z.object({ state: z.literal("unclaimed") }).strict(),
  z.object({ state: z.literal("starting") }).strict(),
  z
    .object({
      state: z.literal("active"),
      sessionId: z.string(),
      url: z.string(),
      attachCommand: z.string(),
    })
    .strict(),
]);

export const cloudSessionContract = {
  input: z.object({ threadId: z.string().min(1) }).strict(),
  output: cloudSessionSchema,
};

/** The Devin Cloud session behind a bb thread. Hidden for good unless the
 *  thread is Devin and not pinned local; starting until the bridge reports the
 *  session id. */
export async function cloudSession(
  ctx: TargetsContext,
  { threadId }: z.output<typeof cloudSessionContract.input>,
): Promise<z.input<typeof cloudSessionContract.output>> {
  const target = ctx.targets.target(threadId);
  if (target === "local") return { state: "hidden" as const };
  const thread = await ctx.bb.sdk.threads.get({ threadId });
  if (thread.providerId !== DEVIN_PROVIDER_ID) return { state: "hidden" as const };
  if (target === null) return { state: "unclaimed" as const };
  const [identity] = await ctx.bb.sdk.threads.events.list({
    threadId,
    types: ["thread/identity"],
    order: "desc",
    limit: "1",
  });
  return identity?.type === "thread/identity"
    ? cloudSessionView(identity.data.providerThreadId)
    : { state: "starting" as const };
}
