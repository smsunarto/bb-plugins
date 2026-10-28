import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountSchema, prKey, prRefSchema } from "../../shared/schema.ts";
import { linkThread } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadPrHead } from "../lib/pull-request.ts";

type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

/**
 * The new-thread composer's request, passed through. bb validates it in
 * full when the thread is spawned; this only checks it is one.
 */
const newThreadRequest = z.looseObject({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  environment: z.looseObject({ type: z.string() }),
  input: z.array(z.unknown()),
});

/** Starts the thread the reader composed to fix failing checks, linked to the pull request. */
export const startFixContract = {
  input: z.strictObject({
    account: accountSchema,
    ref: prRefSchema,
    headRefOid: z.string().min(1),
    request: newThreadRequest,
  }),
  output: z.strictObject({ threadId: z.string() }),
};

export async function startFix(
  ctx: CodeReviewContext,
  { account, ref, headRefOid, request }: z.output<typeof startFixContract.input>,
): Promise<z.input<typeof startFixContract.output>> {
  // `headRefOid` is the commit the failing checks ran on. Only GitHub knows
  // the base, so it is read before anything starts.
  const { baseRefName } = await loadPrHead(ctx.github.as(account), ref);
  const thread = await ctx.bb.sdk.threads.spawn({
    ...request,
    title: `Fix checks on ${prKey(ref)}`,
    visibility: "visible",
    pluginMetadata: { kind: "fix", pr: prKey(ref) },
  } as SpawnArgs);
  await linkThread(ctx.bb, ctx.store, prKey(ref), {
    threadId: thread.id,
    kind: "fix",
    headRefOid,
    baseRefName,
  });
  return { threadId: thread.id };
}
