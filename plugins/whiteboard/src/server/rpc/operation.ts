import type { ReviewApi } from "../lib/review/api.ts";
import { rpcError } from "../lib/boundary-errors.ts";
import type { WhiteboardContext } from "../lib/context.ts";

/**
 * Run one operation for an RPC caller: inside the engine as the panel's
 * thread, its failures mapped to refusals or crashes. The answer goes out as
 * JSON carries it: bb refuses results that hold `undefined`, which operations
 * leave on optional fields.
 */
export async function runOperation<T>(
  ctx: WhiteboardContext<"engine">,
  operation: string,
  threadId: string | undefined,
  fn: (api: ReviewApi, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await ctx.engine.run({ threadId }, (signal) => fn(ctx.engine.api, signal));
  } catch (error) {
    throw rpcError(operation, error);
  }
  // SAFETY: operations answer JSON data; the round trip only drops undefined fields.
  return result === undefined ? result : (JSON.parse(JSON.stringify(result)) as T);
}
