import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadContext, ThreadContextInput } from "../../shared/contracts/engine.ts";

/**
 * Who is driving the current engine call (design §3.7). Set by
 * `Engine.withThread`, read by `open-panel.ts`, `capabilities()` and the
 * host resolver. The host resolver may cache `hostId` on the stored object.
 */
export const threadContext = new AsyncLocalStorage<ThreadContext>();

/**
 * Run `fn` as `input.threadId`. Without a thread, `fn` runs with no context
 * at all, so a thread-less call never inherits an outer caller's thread.
 */
export function runWithThread<T>(input: ThreadContextInput, fn: () => Promise<T>): Promise<T> {
  if (!input.threadId) return threadContext.exit(fn);
  const context: ThreadContext = { threadId: input.threadId };
  if (input.projectId) context.projectId = input.projectId;
  if (input.signal) context.signal = input.signal;
  return threadContext.run(context, fn);
}

/** The thread driving this call, if any. */
export function currentThread(): ThreadContext | undefined {
  return threadContext.getStore();
}

/** "Whiteboard can put the session in front of the user driving this call" (design §3.7). */
export function desktopAvailable(): boolean {
  return threadContext.getStore() !== undefined;
}
