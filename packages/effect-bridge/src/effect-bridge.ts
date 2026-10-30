import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Inspectable,
  Layer,
  Logger,
  ManagedRuntime,
  References,
} from "effect";

/** The part of the plugin API the runtime binds to. */
export type PluginRuntimeHost = Pick<BbPluginApi, "log" | "onDispose">;

/** An Effect runtime that lives exactly as long as one plugin entry. */
export interface PluginRuntime<R> {
  /**
   * Runs `effect` for an SDK handler. The promise rejects with the original
   * failure or defect, so callers see today's error classes and messages. When
   * `signal` aborts first, the effect is interrupted and the promise rejects
   * with `signal.reason`.
   */
  run<A, E>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal): Promise<A>;
  /**
   * The `start` of a `bb.background.service`. It resolves once the SDK aborts
   * the service and rejects with any other failure, so the SDK's restart with
   * backoff still applies.
   */
  service<E>(effect: Effect.Effect<unknown, E, R>): (signal: AbortSignal) => Promise<void>;
  /**
   * Starts work that nobody awaits. A failure is written to `bb.log` rather
   * than escaping as a detached rejection. Unloading does not wait for it.
   */
  fork<A, E>(effect: Effect.Effect<A, E, R>): void;
}

/**
 * How long unloading waits for calls already running before it interrupts them.
 * bb runs dispose hooks before its own wait for in-flight calls, which also
 * allows 5 s, so this keeps that grace.
 */
const DRAIN_MS = 5_000;

/**
 * Builds `layer` before the plugin factory returns, so a layer that cannot be
 * built fails the plugin load instead of a later handler. Unloading stops new
 * work, gives calls already running `drainMs` to finish, interrupts whatever
 * is left, then releases the layer.
 */
export async function makePluginRuntime<R, E>(
  bb: PluginRuntimeHost,
  layer: Layer.Layer<R, E>,
  { drainMs = DRAIN_MS }: { drainMs?: number } = {},
): Promise<PluginRuntime<R>> {
  const runtime = ManagedRuntime.make(Layer.provideMerge(layer, bbLogger(bb)));
  // Handler calls, which bb lets finish on unload.
  const calls = new Set<Fiber.Fiber<unknown, unknown>>();
  let disposed = false;

  bb.onDispose(async () => {
    disposed = true;
    await Effect.runPromise(Fiber.awaitAll(calls).pipe(Effect.timeoutOption(drainMs)));
    // Closing the runtime interrupts and awaits every fiber it started.
    await runtime.dispose();
  });
  await runtime.context();

  const start = <A, Err>(
    effect: Effect.Effect<A, Err, R>,
    signal?: AbortSignal,
    isCall = false,
  ): Promise<Exit.Exit<A, Err | E>> => {
    const fiber = runtime.runFork(effect, signal ? { signal } : undefined);
    if (isCall) calls.add(fiber);
    return new Promise((resolve) => {
      fiber.addObserver((exit) => {
        calls.delete(fiber);
        resolve(exit);
      });
    });
  };

  return {
    async run(effect, signal) {
      if (disposed) throw new Error("The plugin was unloaded before this call ran.");
      const exit = await start(effect, signal, true);
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) {
        if (signal?.aborted) throw signal.reason;
        if (disposed) throw new Error("The plugin was unloaded before this call finished.");
      }
      throw Cause.squash(exit.cause);
    },
    service: (effect) => async (signal) => {
      if (disposed) return;
      const exit = await start(effect, signal);
      if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
      throw Cause.squash(exit.cause);
    },
    fork(effect) {
      if (disposed) return;
      void start(
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(Cause.pretty(cause)),
          ),
        ),
      );
    },
  };
}

/**
 * Routes `Effect.log*` to the plugin's log, which bb shows with its status.
 * Debug entries pass through too, matching what `bb.log.debug` accepts.
 */
function bbLogger(bb: PluginRuntimeHost): Layer.Layer<never> {
  const logger = Logger.layer([
    Logger.make(({ logLevel, message, cause }) => {
      const parts = Array.isArray(message) ? message : [message];
      const text = parts
        .map((part) => (typeof part === "string" ? part : Inspectable.toStringUnknown(part)))
        .join(" ");
      const line = cause.reasons.length === 0 ? text : `${text}\n${Cause.pretty(cause)}`;
      if (logLevel === "Fatal" || logLevel === "Error") bb.log.error(line);
      else if (logLevel === "Warn") bb.log.warn(line);
      else if (logLevel === "Info") bb.log.info(line);
      else bb.log.debug(line);
    }),
  ]);
  return Layer.merge(logger, Layer.succeed(References.MinimumLogLevel, "Debug"));
}
