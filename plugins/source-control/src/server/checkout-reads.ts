/**
 * Plain-git reads of one environment's checkout for other plugins
 * (core/checkout-reads.ts), routed to the host that has it. Nothing is stored:
 * each call reads the checkout as it is now.
 */
import { Effect } from "effect";
import type { Placement, Problem } from "../core/change.ts";
import type {
  CheckoutFiles,
  CheckoutPatches,
  CheckoutPatchFile,
  CheckoutStatus,
  CheckoutTarget,
} from "../core/checkout-reads.ts";
import type { HostFailure } from "../contract/host.ts";
import {
  callProblem,
  failureProblem,
  hostCall,
  message,
  offline,
  type CallOptions,
  type HostCalls,
} from "./host-calls.ts";
import type { Placements } from "./placement.ts";

type Read<T> = { ok: true; value: T } | { ok: false; problem: Problem };

export function createCheckoutReads(deps: {
  host: HostCalls;
  placements: Pick<Placements, "connected" | "forEnvironment">;
  hostDeadlineMs: number;
}) {
  const { placements } = deps;

  /** One read on the environment's checkout host, as `{ ok, value }` or the problem naming the host. */
  const read = <T>(
    environmentId: string,
    call: (
      placement: Placement,
      options: CallOptions,
    ) => Promise<{ ok: true; value: T } | { ok: false; error: HostFailure }>,
  ) =>
    Effect.gen(function* () {
      const where = yield* placements.forEnvironment(environmentId).pipe(Effect.result);
      if (where._tag === "Failure")
        return {
          ok: false,
          problem: {
            kind: "moved",
            detail: `bb has no environment ${environmentId}: ${message(where.failure)}`,
          },
        } as Read<T>;
      if (where.success.state !== "checkout")
        return { ok: false, problem: { kind: "moved", detail: where.success.reason } } as Read<T>;
      const { placement } = where.success;
      if (!(yield* placements.connected(placement.hostId)))
        return { ok: false, problem: offline(placement) } as Read<T>;
      const answer = yield* hostCall(deps.hostDeadlineMs, (options) =>
        call(placement, options),
      ).pipe(Effect.result);
      if (answer._tag === "Failure") {
        const stillConnected = yield* placements.connected(placement.hostId);
        return {
          ok: false,
          problem: callProblem(placement, answer.failure, stillConnected),
        } as Read<T>;
      }
      return (
        answer.success.ok
          ? { ok: true, value: answer.success.value }
          : { ok: false, problem: failureProblem(placement, answer.success.error) }
      ) as Read<T>;
    });

  return {
    status: Effect.fn("checkoutStatus")(function* (environmentId: string, base: string | null) {
      return yield* read<CheckoutStatus>(environmentId, (placement, options) =>
        deps.host.checkoutStatus(placement.hostId, { path: placement.path, base }, options),
      );
    }),
    files: Effect.fn("checkoutFiles")(function* (environmentId: string, target: CheckoutTarget) {
      return yield* read<CheckoutFiles>(environmentId, (placement, options) =>
        deps.host.checkoutFiles(placement.hostId, { path: placement.path, target }, options),
      );
    }),
    patches: Effect.fn("checkoutPatches")(function* (
      environmentId: string,
      target: CheckoutTarget,
      files: readonly CheckoutPatchFile[],
    ) {
      return yield* read<CheckoutPatches>(environmentId, (placement, options) =>
        deps.host.checkoutPatches(
          placement.hostId,
          { path: placement.path, target, files: [...files] },
          options,
        ),
      );
    }),
  };
}

export type CheckoutReads = ReturnType<typeof createCheckoutReads>;
