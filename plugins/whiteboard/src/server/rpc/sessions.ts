import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { Engine } from "../../shared/contracts/engine.ts";
import { liveSessionInput, sessionsInput } from "../../shared/contracts/rpc.ts";
import type { WhiteboardContext } from "../lib/context.ts";
import { runOperation } from "./operation.ts";

/** Home's catalog rows. */
export function sessions(ctx: WhiteboardContext<"engine">, input: z.output<typeof sessionsInput>) {
  return runOperation(ctx, "sessions", input.threadId, (api) => api.catalog({ mode: input.mode }));
}

/** The current document, its activity and coverage revision; `not_found` once deleted. */
export function liveSession(
  ctx: WhiteboardContext<"engine">,
  input: z.output<typeof liveSessionInput>,
) {
  return runOperation(ctx, "liveSession", input.threadId, (api) =>
    api.liveSession({ reviewId: input.sessionId }),
  );
}

/**
 * While a client watches a `sessions` or `liveSession` read, worktree
 * sources refresh every second, so catalog rows and documents follow edits
 * on disk. bb runs the producer once per distinct watched input and aborts it
 * when the last client of that input leaves or the tab hides; the store
 * counts the holds, so refreshing stops with the last one.
 */
export function watchLiveReads(bb: BbPluginApi, engine: Engine): void {
  const schemas = { sessions: sessionsInput, liveSession: liveSessionInput };
  for (const [method, schema] of Object.entries(schemas))
    bb.rpc.experimental_whileWatched(method, (read, signal) => {
      if (!("input" in read) || !schema.safeParse(read.input).success || signal.aborted) return;
      const release = engine.watchWorktrees();
      signal.addEventListener("abort", release, { once: true });
    });
}
