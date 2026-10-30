import type { PluginRuntime } from "@bb-plugins/effect-bridge";
import { Cause, Effect, Exit, Fiber, FiberSet } from "effect";

/**
 * Runs an Effect for Promise code: the plugin runtime's `run`. It rejects
 * with the effect's own failure, or with `signal`'s reason once that aborts.
 */
export type Run = PluginRuntime<never>["run"];

/** {@link Run} outside a plugin runtime, for collaborators built without one, as tests build them. */
export const runDetached: Run = async (effect, signal) => {
  const exit = await Effect.runPromiseExit(effect, signal ? { signal } : undefined);
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted && Cause.hasInterruptsOnly(exit.cause)) throw signal.reason;
  throw Cause.squash(exit.cause);
};

/**
 * Awaits `work` from a fiber the plugin owns. A caller that stops waiting, at
 * its deadline or because it left, stops only its own wait: a shared read
 * goes on to finish, and is cached for the next caller.
 */
export type Share = <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, E>;

/** {@link Share} in `fibers`, which unloading the plugin interrupts. */
export const shareIn =
  (fibers: FiberSet.FiberSet<unknown, unknown>): Share =>
  (work) =>
    Effect.flatMap(FiberSet.run(fibers, work), Fiber.join);

/** {@link Share} outside a plugin runtime, as tests build collaborators: only the work's own limits stop it. */
export const shareDetached: Share = (work) => Effect.flatMap(Effect.forkDetach(work), Fiber.join);
