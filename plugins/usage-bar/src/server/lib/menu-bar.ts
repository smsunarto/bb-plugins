import { sep } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Data, Effect, FiberSet, Schedule } from "effect";
import { z } from "zod";
import { menuHostContract, menuHostSignals } from "../../shared/host-contract.ts";
import { createMenuState } from "./menu-state.ts";
import { POOL_PLUGIN_ID, createSourceReader } from "./sources.ts";

/** Reading the pool is a local store read; quota itself moves on proxied traffic. */
const POLL_MS = 15_000;
/** The first render on a Mac compiles the helper, which can take a minute. */
const RENDER_TIMEOUT_MS = 5 * 60_000;
/** Refresh asks Account Pooler about a few accounts at a time. */
const REFRESH_CONCURRENCY = 4;

/** A bb SDK call that rejected, or that did not answer within one poll. */
class SdkError extends Data.TaggedError("SdkError")<{ readonly cause: unknown }> {}

const sdkCall = <A>(call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new SdkError({ cause }) });

/**
 * Share one read until it settles, and wait at most one poll for it. An SDK read
 * can ignore its signal, so a read that outlives its callers keeps the slot: later
 * polls join it instead of stacking hung reads.
 */
function singleFlight<A>(read: () => Promise<A>): Effect.Effect<A, SdkError> {
  let pending: Promise<A> | null = null;
  return sdkCall(
    () =>
      (pending ??= read().finally(() => {
        pending = null;
      })),
  ).pipe(
    Effect.timeoutOrElse({
      duration: POLL_MS,
      orElse: () => Effect.fail(new SdkError({ cause: new Error(`No answer in ${POLL_MS} ms`) })),
    }),
  );
}

/**
 * Read quota for the lifetime of the background service and push the menu to
 * every connected host. Each Mac's host entry draws it in that Mac's menu bar,
 * so the items appear on the Mac you use even when the bb server runs elsewhere.
 */
export const menuBar = Effect.fn("menuBar")(function* (bb: BbPluginApi) {
  // Dev bb instances auto-install workspace plugins and would each draw duplicate items.
  if (
    bb.server.experimental_dataDir.split(sep).includes(".bb-dev") &&
    process.env.BB_USAGE_BAR_ANY_INSTANCE !== "1"
  ) {
    bb.log.info("usage-bar: dev bb instances do not draw the menu bar; idling.");
    return yield* Effect.never;
  }

  const fibers = yield* FiberSet.make();
  const run = yield* FiberSet.runtime(fibers)();
  const runPromise = yield* FiberSet.runtimePromise(fibers)();
  // Released before the fiber set, so plain reads see shutdown before their callers stop.
  const { signal } = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  );

  const client = bb.hosts.experimental_client({
    contract: menuHostContract,
    experimental_signals: menuHostSignals,
  });
  let refreshing = false;
  let hostIds: string[] = [];
  /** Hosts whose entry answered that it cannot draw a menu bar. */
  const unsupported = new Set<string>();
  const problems = new Map<string, string>();
  /** One render in flight per host; a newer menu waits for it, then goes out. */
  const inFlight = new Set<string>();
  const pending = new Set<string>();

  const draw = (hostId: string) =>
    sdkCall((signal) =>
      client.call(
        "render",
        { snapshot: state.snapshot(), refreshing },
        { hostId, signal, timeoutMs: RENDER_TIMEOUT_MS },
      ),
    ).pipe(
      Effect.match({
        onSuccess: (result) => {
          if (result.status === "unsupported") unsupported.add(hostId);
          const problem = result.status === "needs-configuration" ? result.message : undefined;
          if (problem !== undefined && problems.get(hostId) !== problem) {
            bb.log.warn(`usage-bar: host ${hostId}: ${problem}`);
            // Other Macs keep drawing, so mark the plugin instead of stopping the service.
            bb.status.needsConfiguration(`Host ${hostId}: ${problem}`);
          }
          if (problem === undefined) problems.delete(hostId);
          else problems.set(hostId, problem);
        },
        onFailure: (error) =>
          bb.log.debug(`usage-bar: render on host ${hostId} failed: ${String(error.cause)}`),
      }),
    );
  const renderOn = (hostId: string) => {
    if (inFlight.has(hostId)) {
      pending.add(hostId);
      return;
    }
    inFlight.add(hostId);
    run(
      draw(hostId).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inFlight.delete(hostId);
            if (pending.delete(hostId) && !signal.aborted) renderOn(hostId);
          }),
        ),
      ),
    );
  };
  const render = () => {
    for (const hostId of hostIds) if (!unsupported.has(hostId)) renderOn(hostId);
  };
  const listHosts = singleFlight(() => bb.sdk.hosts.list({ signal })).pipe(
    Effect.match({
      onSuccess: (hosts) => {
        hostIds = hosts.filter((host) => host.status === "connected").map((host) => host.id);
      },
      onFailure: (error) => bb.log.debug(`usage-bar: listing hosts failed: ${String(error.cause)}`),
    }),
  );

  const state = createMenuState(signal, render);
  const readSource = createSourceReader(bb);
  const pollRead = singleFlight(() => readSource(signal, false));
  const refreshRead = singleFlight(() => readSource(signal, true));

  const publish = (refresh: boolean) =>
    Effect.promise(() =>
      state.publish(() => runPromise(refresh ? refreshRead : pollRead), refresh),
    );

  const refreshPool = Effect.suspend(() => {
    const source = state.source;
    if (source?.kind !== "pool") return Effect.void;
    const accounts = source.providers
      .flatMap((provider) => provider.accounts)
      .filter((account) => account.status !== "disabled");
    // Each account settles on its own, and Refresh waits at most one poll for the slowest.
    return Effect.forEach(
      accounts,
      (account) =>
        sdkCall((signal) =>
          bb.sdk.plugins.callRpc({
            pluginId: POOL_PLUGIN_ID,
            method: "account.refreshUsage",
            input: { accountId: account.id },
            outputSchema: z.unknown(),
            signal,
          }),
        ).pipe(Effect.ignore),
      { concurrency: REFRESH_CONCURRENCY, discard: true },
    ).pipe(Effect.timeout(POLL_MS), Effect.ignore);
  });
  const refreshAll = Effect.suspend(() => {
    if (refreshing) return Effect.void;
    refreshing = true;
    render();
    return refreshPool.pipe(
      Effect.andThen(publish(true)),
      Effect.ensuring(
        Effect.sync(() => {
          refreshing = false;
          render();
        }),
      ),
    );
  });

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      client.experimental_onSignal("menu", ({ payload }) => {
        run(payload.type === "refresh" ? refreshAll : publish(false));
      }),
    ),
    (stopSignals) => Effect.sync(stopSignals),
  );

  yield* listHosts;
  yield* publish(false);
  return yield* Effect.schedule(
    Effect.gen(function* () {
      yield* listHosts;
      // Unchanged quota publishes nothing, so render here too: a host that just
      // connected or restarted its worker gets the menu, and each host skips
      // redrawing what it already shows.
      render();
      yield* publish(false);
    }),
    Schedule.spaced(POLL_MS),
  );
}, Effect.scoped);
