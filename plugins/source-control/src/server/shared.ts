/**
 * Work several callers want once: the first caller starts it in a fiber the
 * plugin owns, later callers with the same key join it until it ends. A
 * caller that stops waiting stops only its own wait, so a shared read still
 * lands in the store for the others. Unloading the plugin interrupts it.
 */
import { Context, Effect, Fiber, FiberMap, Layer, Option } from "effect";

export type Share = <A, E>(key: string, work: Effect.Effect<A, E>) => Effect.Effect<A, E>;

export class SharedWork extends Context.Service<SharedWork, Share>()(
  "source-control/server/SharedWork",
) {
  static readonly layer = Layer.effect(
    SharedWork,
    Effect.gen(function* () {
      const running = yield* FiberMap.make<string, unknown, unknown>();
      const start = yield* FiberMap.runtime(running)<never>();
      // Looking up and starting in one synchronous step: no second fiber can start between them.
      const share: Share = <A, E>(key: string, work: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          const current = FiberMap.getUnsafe(running, key);
          const fiber = Option.isSome(current) ? current.value : start(key, work);
          return Fiber.join(fiber as Fiber.Fiber<A, E>);
        });
      return SharedWork.of(share);
    }),
  );
}
