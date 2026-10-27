import type {
  GenerationJob,
  GenerationStartResponse,
  MediaRequest,
} from "@argus-labs/game-studio-api";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type Declined, withApproval } from "./approval-relay.ts";
import type { StudioClient } from "./studio-client.ts";
import { gameForThread } from "./thread-game.ts";

/** What the tools and RPC units see of the studio: bb, and the client over the plugin's settings. */
export type StudioContext = { bb: BbPluginApi; studio: StudioClient };

/** The checks every tool makes before it asks the studio for anything on a thread's behalf. */
export async function toolSession(ctx: StudioContext, gameId: string, threadId?: string) {
  if (!threadId) throw new Error("Game Studio tools run in a bb thread.");
  const api = await ctx.studio.client();
  const recheck = () => gameForThread(ctx.bb, api, gameId, threadId);
  await recheck();
  return { api, threadId, recheck };
}

/** A generation the agent wrote itself, approved in the thread when the studio asks. */
export async function startGeneration(
  ctx: StudioContext,
  gameId: string,
  requestId: string,
  request: MediaRequest,
  threadId: string | undefined,
  target?: GenerationJob["target"],
): Promise<Exclude<GenerationStartResponse, { approvalRequired: true }> | Declined> {
  const session = await toolSession(ctx, gameId, threadId);
  return withApproval({ bb: ctx.bb, gameId, ...session }, () =>
    session.api.generations.start(gameId, {
      requestId,
      request,
      ...(target ? { target } : {}),
      threadId: session.threadId,
    }),
  );
}
