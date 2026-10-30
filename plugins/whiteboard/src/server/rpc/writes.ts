import { z } from "zod";
import type { copyContextInput, markProgressInput } from "../../shared/contracts/rpc.ts";
import type { WhiteboardContext } from "../lib/context.ts";
import { commandSchema } from "../lib/review/store.ts";
import { runOperation } from "./operation.ts";

type Ctx = WhiteboardContext<"engine">;

/** A store command as the panel sends it: Home's attention and delete. */
export const commandInput = commandSchema.extend({ threadId: z.string().min(1).optional() });

export function command(ctx: Ctx, input: z.output<typeof commandInput>) {
  const { threadId, ...command } = input;
  return runOperation(ctx, "command", threadId, (api, signal) => api.command(command, { signal }));
}

/** Mark files viewed; answers the progress at `version` after the write. */
export function markProgress(ctx: Ctx, input: z.output<typeof markProgressInput>) {
  const { threadId, sessionId, ...update } = input;
  return runOperation(ctx, "markProgress", threadId, (api, signal) =>
    api.markProgress({ reviewId: sessionId, ...update }, { signal }),
  );
}

export function copyContext(ctx: Ctx, input: z.output<typeof copyContextInput>) {
  return runOperation(ctx, "copyContext", input.threadId, (api) =>
    api.copyContext({
      reviewId: input.sessionId,
      version: input.version,
      selection: input.selection,
    }),
  );
}
